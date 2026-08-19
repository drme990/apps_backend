import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import Order from '@/lib/models/Order';
import { listVersions, resolveDesignIdentity } from '@/lib/services/design-version-history';

/**
 * GET /api/admin/design-versions
 *
 * Returns the full saved-version history for a single order design,
 * plus the explicit `currentVersion` pointer (see
 * `order-history-enhanced.md` §11, §14).
 *
 * Query params:
 *   - orderId    : the order's MongoDB _id (preferred — used to resolve
 *                  the orderNumber and itemIndex)
 *   - productId  : the backend product ID
 *   - orderNumber: optional, used when orderId is not available
 *   - itemIndex  : optional 1-based item index (auto-resolved from
 *                  orderId + productId when orderId is provided)
 *
 * Response:
 *   {
 *     success: true,
 *     data: {
 *       currentVersion: number | null,
 *       versions: OrderDesignVersion[]
 *     }
 *   }
 *
 * `currentVersion` is null when the design has been deleted (the
 * `admin_delete` event preserves the last snapshot but clears the
 * active pointer). It is undefined/null for legacy entries that haven't
 * been backfilled yet — the UI treats both as "no current version".
 */
export async function GET(request: NextRequest) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess(['orders', 'orderDesigns']);
    if ('error' in auth) return auth.error;

    const { searchParams } = request.nextUrl;
    const orderId = searchParams.get('orderId') || undefined;
    const productId = searchParams.get('productId') || undefined;
    const orderNumber = searchParams.get('orderNumber') || undefined;
    const itemIndexRaw = searchParams.get('itemIndex');
    const itemIndex = itemIndexRaw ? Number(itemIndexRaw) : undefined;

    if (!productId) {
      return NextResponse.json(
        { success: false, error: { code: 'ERR_VALIDATION', message: 'Missing productId' } },
        { status: 400 },
      );
    }

    // ── Resolve identity ───────────────────────────────────────────────
    // Prefer orderId (lets us resolve the 1-based itemIndex from the
    // order's items array and read the explicit currentVersion pointer
    // from the designUrls entry). Fall back to (orderNumber, itemIndex).
    let resolvedOrderNumber = orderNumber;
    let resolvedItemIndex = itemIndex ?? null;
    let currentVersion: number | null | undefined = null;

    if (orderId) {
      const order = await Order.findById(orderId).lean();
      if (!order) {
        return NextResponse.json(
          { success: false, error: { code: 'ERR_NOT_FOUND', message: 'Order not found' } },
          { status: 404 },
        );
      }
      resolvedOrderNumber = order.orderNumber;
      const resolved = resolveDesignIdentity(order, productId);
      if (resolved) {
        resolvedItemIndex = resolved.identity.itemIndex ?? null;
        const design = (order.designUrls || []).find(
          (d) => String(d.productId) === String(productId),
        );
        currentVersion = design?.currentVersion ?? null;
      } else {
        // Product not in the order's items — use the provided itemIndex
        // or default to null. The design entry may still exist in history.
        const design = (order.designUrls || []).find(
          (d) => String(d.productId) === String(productId),
        );
        currentVersion = design?.currentVersion ?? null;
      }
    } else if (!resolvedOrderNumber) {
      return NextResponse.json(
        {
          success: false,
          error: { code: 'ERR_VALIDATION', message: 'Either orderId or orderNumber is required' },
        },
        { status: 400 },
      );
    }

    // ── Fetch history (newest first) ───────────────────────────────────
    const versions = await listVersions({
      orderNumber: resolvedOrderNumber,
      productId,
      itemIndex: resolvedItemIndex,
    });

    return NextResponse.json({
      success: true,
      data: {
        currentVersion: currentVersion ?? null,
        versions: versions.map((v) => ({
          _id: String(v._id),
          version: v.version,
          projectId: v.projectId,
          archivedUrl: v.archivedUrl,
          archivedKey: v.archivedKey,
          layers: v.layers,
          canvasWidth: v.canvasWidth,
          canvasHeight: v.canvasHeight,
          backgroundColor: v.backgroundColor,
          backgroundUri: v.backgroundUri,
          userId: v.userId,
          userName: v.userName,
          userRole: v.userRole,
          trigger: v.trigger,
          createdAt: v.createdAt,
          restoredFromVersion: v.restoredFromVersion,
          isDeletedEvent: v.isDeletedEvent,
          designHash: v.designHash,
        })),
      },
    });
  } catch (error) {
    console.error('[GET /api/admin/design-versions]', error);
    return NextResponse.json(
      { success: false, error: { code: 'internalError', message: 'Failed to fetch design history' } },
      { status: 500 },
    );
  }
}
