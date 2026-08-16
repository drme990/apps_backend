import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import Order, { type IOrder } from '@/lib/models/Order';
import { logActivity } from '@/lib/services/logger';
import { deleteDesignProjects } from '@/lib/services/design-app-callback';

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * PATCH /api/admin/orders/[id]/designs
 *
 * Updates a single design (identified by `productId`). Supports two
 * independent operations (either or both can be sent in one request):
 *   - `reviewed` (boolean) — marks the design reviewed / not-reviewed.
 *     Used by the "order-designs" page and the order detail modal so
 *     admins with `orderDesigns` access can track which generated
 *     designs have already been checked.
 *   - `url` (string) — replaces the design's image with an admin-uploaded
 *     one (e.g. via the "upload" action on the order-designs page). This
 *     resets `reviewed` back to `false` unless `reviewed` was explicitly
 *     provided in the same request, since the image content changed.
 *
 * Body: { productId: string; reviewed?: boolean; url?: string }
 */
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess(['orders', 'orderDesigns']);
    if ('error' in auth) return auth.error;

    const { id } = await params;
    const body = await request.json().catch(() => null);
    const productId = body?.productId;
    const reviewed = body?.reviewed;
    const url = body?.url;

    if (typeof productId !== 'string' || !productId) {
      return NextResponse.json(
        { success: false, error: { code: 'ERR_VALIDATION', message: 'Missing productId' } },
        { status: 400 },
      );
    }
    const hasReviewed = typeof reviewed === 'boolean';
    const hasUrl = typeof url === 'string' && url.trim().length > 0;
    if (!hasReviewed && !hasUrl) {
      return NextResponse.json(
        { success: false, error: { code: 'ERR_VALIDATION', message: 'Nothing to update' } },
        { status: 400 },
      );
    }

    const order = (await Order.findById(id).lean()) as IOrder | null;
    if (!order) {
      return NextResponse.json(
        { success: false, error: { code: 'ERR_NOT_FOUND', message: 'Order not found' } },
        { status: 404 },
      );
    }

    const designUrls = order.designUrls || [];
    const designIndex = designUrls.findIndex((d) => d.productId === productId);
    if (designIndex === -1) {
      return NextResponse.json(
        { success: false, error: { code: 'ERR_NOT_FOUND', message: 'Design not found' } },
        { status: 404 },
      );
    }

    // Replacing the image resets the review status, unless the caller
    // also explicitly set `reviewed` in the same request.
    const nextReviewed = hasReviewed ? reviewed : (hasUrl ? false : designUrls[designIndex].reviewed);

    const setFields: Record<string, unknown> = {
      'designUrls.$.reviewed': nextReviewed,
      'designUrls.$.reviewedAt': nextReviewed ? new Date() : null,
      'designUrls.$.reviewedBy': nextReviewed ? (auth.user.name || auth.user.email) : null,
    };
    if (hasUrl) {
      setFields['designUrls.$.url'] = url;
    }

    const result = await Order.updateOne(
      { _id: id, 'designUrls.productId': productId },
      { $set: setFields },
    );

    if (result.matchedCount === 0) {
      return NextResponse.json(
        { success: false, error: { code: 'ERR_NOT_FOUND', message: 'Order not found' } },
        { status: 404 },
      );
    }

    try {
      await logActivity({
        action: hasUrl ? 'update' : (nextReviewed ? 'review_design' : 'unreview_design'),
        resource: 'order',
        resourceId: id,
        userId: auth.user.userId,
        userName: auth.user.name,
        userEmail: auth.user.email,
        details: JSON.stringify({
          orderNumber: order.orderNumber,
          productId,
          ...(hasUrl ? { replacedImage: true } : {}),
          reviewed: nextReviewed,
        }),
      });
    } catch (logError) {
      console.error('[PATCH /api/admin/orders/[id]/designs] logActivity failed:', logError);
    }

    return NextResponse.json({ success: true, data: { productId, reviewed: nextReviewed, url: hasUrl ? url : undefined } });
  } catch (error) {
    console.error('[PATCH /api/admin/orders/[id]/designs]', error);
    return NextResponse.json(
      { success: false, error: { code: 'internalError', message: 'Failed to update design' } },
      { status: 500 },
    );
  }
}

/**
 * DELETE /api/admin/orders/[id]/designs
 *
 * Deletes all design instance projects and R2 assets for an order.
 * This is used before regenerating designs (the admin panel calls
 * DELETE then POST generate-design).
 *
 * Flow:
 *   1. Verify admin auth.
 *   2. Load the order.
 *   3. Collect all projectIds from designUrls.
 *   4. Call the design app callback to delete the project documents
 *      and their R2 assets (order design JPG, thumbnails, layer images).
 *   5. Clear the order's designUrls array.
 *   6. Log the action.
 */
export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess(['orders', 'orderDesigns']);
    if ('error' in auth) return auth.error;

    const { id } = await params;

    const order = (await Order.findById(id).lean()) as IOrder | null;
    if (!order) {
      return NextResponse.json(
        { success: false, error: { code: 'ERR_NOT_FOUND', message: 'Order not found' } },
        { status: 404 },
      );
    }

    const designUrls = order.designUrls || [];
    if (designUrls.length === 0) {
      return NextResponse.json({ success: true, data: { deleted: 0 } });
    }

    // Collect projectIds to delete on the design app
    const projectIds = designUrls
      .map((d) => d.projectId)
      .filter((pid): pid is string => Boolean(pid));

    // Call the design app to delete project documents + R2 assets
    if (projectIds.length > 0) {
      const result = await deleteDesignProjects(projectIds);
      if (!result.success) {
        console.error('[DELETE /api/admin/orders/[id]/designs] design app deletion failed:', result.error);
        // Continue anyway — we still clear designUrls on the order
      }
    }

    // Clear designUrls on the order
    await Order.updateOne(
      { _id: order._id },
      { $set: { designUrls: [] } },
    );

    // Log the action
    try {
      await logActivity({
        action: 'delete_designs',
        resource: 'order',
        resourceId: String(order._id),
        userId: auth.user.userId,
        userName: auth.user.name,
        userEmail: auth.user.email,
        details: JSON.stringify({
          orderNumber: order.orderNumber,
          deletedCount: designUrls.length,
          projectIds,
        }),
      });
    } catch (logError) {
      console.error('[DELETE /api/admin/orders/[id]/designs] logActivity failed:', logError);
    }

    return NextResponse.json({
      success: true,
      data: { deleted: designUrls.length },
    });
  } catch (error) {
    console.error('[DELETE /api/admin/orders/[id]/designs]', error);
    return NextResponse.json(
      { success: false, error: { code: 'internalError', message: 'Failed to delete designs' } },
      { status: 500 },
    );
  }
}
