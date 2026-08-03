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
    const auth = await requireAdminPageAccess(['orders']);
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
