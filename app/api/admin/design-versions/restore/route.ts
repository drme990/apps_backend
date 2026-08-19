import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import Order from '@/lib/models/Order';
import {
  buildRestoreOperationId,
  resolveDesignIdentity,
  restoreVersion,
  findVersionByOperationId,
} from '@/lib/services/design-version-history';

/**
 * POST /api/admin/design-versions/restore
 *
 * Restore a previous saved version. Treats restore as a NEW history
 * event (see `order-history-enhanced.md` §9, §10): the original version
 * is never touched. A new version is created with `trigger:
 * 'admin_restore'` and `restoredFromVersion` pointing to the target.
 *
 * Body:
 *   {
 *     orderId: string,
 *     productId: string,
 *     version: number
 *   }
 *
 * The `itemIndex` is auto-resolved from the order's items array. The
 * actor (userId, name, role) is derived from the authenticated admin
 * session — the client never sends identity.
 *
 * Response:
 *   {
 *     success: true,
 *     data: {
 *       restoredFromVersion: number,
 *       newVersion: number,
 *       currentVersion: number,
 *       url: string
 *     }
 *   }
 *
 * Idempotency: a stable operationId is derived from
 * (orderNumber, productId, itemIndex, targetVersion). An accidental
 * double-click (or a network retry) returns the existing restore
 * version instead of creating a duplicate.
 */
export async function POST(request: NextRequest) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess(['orders', 'orderDesigns']);
    if ('error' in auth) return auth.error;

    const body = await request.json().catch(() => null);
    const orderId = body?.orderId;
    const productId = body?.productId;
    const targetVersion = Number(body?.version);

    if (!orderId || typeof orderId !== 'string') {
      return NextResponse.json(
        { success: false, error: { code: 'ERR_VALIDATION', message: 'Missing orderId' } },
        { status: 400 },
      );
    }
    if (!productId || typeof productId !== 'string') {
      return NextResponse.json(
        { success: false, error: { code: 'ERR_VALIDATION', message: 'Missing productId' } },
        { status: 400 },
      );
    }
    if (!Number.isInteger(targetVersion) || targetVersion < 1) {
      return NextResponse.json(
        { success: false, error: { code: 'ERR_VALIDATION', message: 'Invalid version' } },
        { status: 400 },
      );
    }

    // ── Load the order ─────────────────────────────────────────────────
    const order = await Order.findById(orderId).lean();
    if (!order) {
      return NextResponse.json(
        { success: false, error: { code: 'ERR_NOT_FOUND', message: 'Order not found' } },
        { status: 404 },
      );
    }

    // ── Resolve identity + design index ────────────────────────────────
    const resolved = resolveDesignIdentity(order, productId);
    const identity = resolved
      ? resolved.identity
      : { orderNumber: order.orderNumber, productId, itemIndex: null };
    const designIndex = resolved?.designIndex ?? -1;

    // ── Idempotency: stable operationId per (identity, target) ─────────
    const operationId = buildRestoreOperationId(identity, targetVersion);
    const existing = await findVersionByOperationId(operationId);
    if (existing) {
      // Already restored — return the existing result so a retry is a
      // no-op. The order pointer was already updated in the first call.
      return NextResponse.json({
        success: true,
        data: {
          restoredFromVersion: existing.restoredFromVersion,
          newVersion: existing.version,
          currentVersion: existing.version,
          url: existing.archivedUrl,
        },
      });
    }

    // ── Authorize the actor from the session ───────────────────────────
    const actor = {
      userId: auth.user.userId,
      userName: auth.user.name || auth.user.email,
      userEmail: auth.user.email,
      userRole: auth.user.role || 'admin',
    };

    // ── Perform the restore ────────────────────────────────────────────
    const result = await restoreVersion({
      order,
      identity,
      designIndex,
      targetVersion,
      actor,
      operationId,
    });

    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to restore version';
    const code =
      message === 'TARGET_VERSION_NOT_FOUND'
        ? 'ERR_NOT_FOUND'
        : message === 'CANNOT_RESTORE_DELETE_EVENT'
          ? 'ERR_VALIDATION'
          : 'internalError';
    const status =
      code === 'ERR_NOT_FOUND' ? 404 : code === 'ERR_VALIDATION' ? 400 : 500;
    if (status === 500) {
      console.error('[POST /api/admin/design-versions/restore]', error);
    }
    return NextResponse.json(
      { success: false, error: { code, message } },
      { status },
    );
  }
}
