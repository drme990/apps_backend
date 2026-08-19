import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import Order from '@/lib/models/Order';
import OrderDesignVersion from '@/lib/models/OrderDesignVersion';

/**
 * Maximum time to wait for new versions (in milliseconds). The endpoint
 * checks every 500ms for new versions and returns as soon as it finds
 * one (or after this timeout).
 */
const MAX_WAIT_MS = 10_000;
const POLL_INTERVAL_MS = 500;

/**
 * POST /api/admin/orders/sync-designs
 *
 * Syncs the order's `designUrls[].url` and `currentVersion` with the
 * latest version in the `order_design_versions` collection.
 *
 * **Long-poll mode** (default): when `wait: true` is in the body, the
 * endpoint checks for newer versions, and if none found, waits up to 10
 * seconds (checking every 500ms) for a new version to appear. This is
 * a single request that handles the waiting — no client-side polling
 * needed. Returns as soon as a new version is found and the order is
 * updated, or after the timeout.
 *
 * This is the reliable path for updating the order's design URL after
 * the admin edits a design in the design app's editor:
 *
 *   1. Admin edits design → saves → editor fires re-render (fire-and-forget)
 *   2. Admin returns to /order-designs page → admin panel calls this
 *      endpoint with `wait: true`
 *   3. The endpoint checks for newer versions. If the re-render hasn't
 *      completed yet, it waits (up to 10s) and rechecks every 500ms.
 *   4. When the new version appears, the endpoint updates the order's
 *      URL and returns immediately.
 *   5. The admin panel refetches the orders → new image loads.
 *
 * Body:
 *   {
 *     orderNumbers: string[],  — the order numbers to sync
 *     wait?: boolean           — when true, long-poll for new versions
 *                                (default: false for backward compat)
 *   }
 *
 * Response:
 *   200 — { success: true, data: { synced: number, updated: number, timedOut: boolean } }
 *   401 — not authenticated
 *   403 — not authorized
 *
 * Auth: requires `orders` or `orderDesigns` page access.
 */
export async function POST(request: NextRequest) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess(['orders', 'orderDesigns']);
    if ('error' in auth) return auth.error;

    const body = await request.json().catch(() => null);
    const orderNumbers: string[] = Array.isArray(body?.orderNumbers)
      ? body.orderNumbers.filter((n: unknown): n is string => typeof n === 'string')
      : [];
    const wait: boolean = body?.wait === true;

    if (orderNumbers.length === 0) {
      return NextResponse.json({
        success: true,
        data: { synced: 0, updated: 0, timedOut: false },
      });
    }

    // ── Snapshot the current versions before waiting ───────────────────
    // We capture the max version number per (orderNumber, productId) at
    // the start. During long-poll, we only need to check if a NEWER
    // version appeared — much cheaper than re-running the full sync.
    const initialSnapshot = await getLatestVersions(orderNumbers);

    // ── First sync attempt (immediate) ─────────────────────────────────
    let result = await syncOrders(orderNumbers, initialSnapshot);
    if (result.updated > 0 || !wait) {
      return NextResponse.json({
        success: true,
        data: { ...result, timedOut: false },
      });
    }

    // ── Long-poll: wait for new versions to appear ─────────────────────
    // The re-render on the design app is async (render + R2 upload takes
    // ~2-5s). Instead of making the client poll multiple times, we wait
    // here on the backend — checking every 500ms for a new version.
    const startTime = Date.now();
    let timedOut = false;

    while (Date.now() - startTime < MAX_WAIT_MS) {
      // Sleep for POLL_INTERVAL_MS before checking again
      await sleep(POLL_INTERVAL_MS);

      // Check for newer versions since the initial snapshot
      const currentVersions = await getLatestVersions(orderNumbers);
      const hasNewVersion = checkForNewerVersions(initialSnapshot, currentVersions);

      if (hasNewVersion) {
        // A new version appeared! Sync the orders and return.
        result = await syncOrders(orderNumbers, currentVersions);
        return NextResponse.json({
          success: true,
          data: { ...result, timedOut: false },
        });
      }
    }

    // Timed out — no new version appeared within MAX_WAIT_MS.
    // Return the initial sync result (which may have updated=0).
    timedOut = true;
    return NextResponse.json({
      success: true,
      data: { ...result, timedOut },
    });
  } catch {
    return NextResponse.json(
      { success: false, error: { code: 'internalError', message: 'Failed to sync designs' } },
      { status: 500 },
    );
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Get the latest non-delete version for each (orderNumber, productId) pair.
 * Returns a Map keyed by `${orderNumber}:${productId}` → { version, archivedUrl }.
 */
async function getLatestVersions(
  orderNumbers: string[],
): Promise<Map<string, { version: number; archivedUrl: string }>> {
  // First get the pairs from the orders
  const orders = await Order.find({
    orderNumber: { $in: orderNumbers },
    'designUrls.0': { $exists: true },
  }).lean();

  const pairs: Array<{ orderNumber: string; productId: string }> = [];
  for (const order of orders) {
    for (const design of order.designUrls || []) {
      pairs.push({
        orderNumber: order.orderNumber,
        productId: String(design.productId),
      });
    }
  }

  if (pairs.length === 0) {
    return new Map();
  }

  const latestVersions = await OrderDesignVersion.aggregate([
    {
      $match: {
        $or: pairs.map((p) => ({
          orderNumber: p.orderNumber,
          productId: p.productId,
        })),
        isDeletedEvent: { $ne: true },
      },
    },
    { $sort: { version: -1 } },
    {
      $group: {
        _id: { orderNumber: '$orderNumber', productId: '$productId' },
        latestVersion: { $first: '$$ROOT' },
      },
    },
  ]);

  const map = new Map<string, { version: number; archivedUrl: string }>();
  for (const entry of latestVersions) {
    const key = `${entry._id.orderNumber}:${entry._id.productId}`;
    const v = entry.latestVersion;
    if (v?.archivedUrl && typeof v.version === 'number') {
      map.set(key, { version: v.version, archivedUrl: v.archivedUrl });
    }
  }
  return map;
}

/**
 * Check if any version in `current` is newer than in `initial`.
 */
function checkForNewerVersions(
  initial: Map<string, { version: number; archivedUrl: string }>,
  current: Map<string, { version: number; archivedUrl: string }>,
): boolean {
  for (const [key, currentVal] of current) {
    const initialVal = initial.get(key);
    if (!initialVal || currentVal.version > initialVal.version) {
      return true;
    }
  }
  return false;
}

/**
 * Sync the orders' designUrls with the latest versions.
 * Returns { synced, updated }.
 */
async function syncOrders(
  orderNumbers: string[],
  latestMap: Map<string, { version: number; archivedUrl: string }>,
): Promise<{ synced: number; updated: number }> {
  const orders = await Order.find({
    orderNumber: { $in: orderNumbers },
    'designUrls.0': { $exists: true },
  }).lean();

  if (orders.length === 0) {
    return { synced: 0, updated: 0 };
  }

  let updated = 0;
  const bulkOps: Array<{
    updateOne: {
      filter: Record<string, unknown>;
      update: {
        $set: {
          'designUrls.$.url': string;
          'designUrls.$.currentVersion': number;
        };
      };
    };
  }> = [];

  for (const order of orders) {
    const orderId = String(order._id);
    for (const design of order.designUrls || []) {
      const productId = String(design.productId);
      const key = `${order.orderNumber}:${productId}`;
      const latest = latestMap.get(key);

      if (!latest) continue;

      const currentVersion = design.currentVersion ?? null;
      const currentUrl = design.url;
      if (currentVersion === latest.version && currentUrl === latest.archivedUrl) {
        continue; // already in sync
      }

      bulkOps.push({
        updateOne: {
          filter: {
            _id: orderId,
            'designUrls.productId': productId,
          },
          update: {
            $set: {
              'designUrls.$.url': latest.archivedUrl,
              'designUrls.$.currentVersion': latest.version,
            },
          },
        },
      });
      updated++;
    }
  }

  if (bulkOps.length > 0) {
    await Order.bulkWrite(bulkOps as Parameters<typeof Order.bulkWrite>[0]);
  }

  return { synced: orders.length, updated };
}
