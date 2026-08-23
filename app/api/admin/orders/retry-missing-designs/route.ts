import { NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import Order, { type IOrder } from '@/lib/models/Order';
import { triggerAutoDesignGeneration } from '@/lib/services/auto-design-generation';

/**
 * POST /api/admin/orders/retry-missing-designs
 *
 * Finds all paid/partial-paid/completed orders that have NO design URLs
 * and triggers auto design generation for each one (fire-and-forget).
 *
 * This is the safety net for cases where the initial auto-generation
 * failed silently (serverless timeout, network error, process killed
 * before the fire-and-forget promise settled, etc.).
 *
 * Returns the list of order IDs that were queued for retry, so the
 * admin can see how many orders were missing designs.
 */
export async function POST() {
  const auth = await requireAdminPageAccess(['orders', 'orderDesignLogs']);
  if ('error' in auth) return auth.error;

  try {
    await connectDB();

    // Find all paid-like orders with no design URLs (or empty array)
    const missingOrders = (await Order.find({
      status: { $in: ['paid', 'partial-paid', 'completed'] },
      $or: [
        { designUrls: { $exists: false } },
        { designUrls: { $size: 0 } },
        { designUrls: null },
      ],
    })
      .select('_id orderNumber status source')
      .lean()) as Array<Pick<IOrder, '_id' | 'orderNumber' | 'status' | 'source'>>;

    if (missingOrders.length === 0) {
      return NextResponse.json({
        success: true,
        data: { queuedCount: 0, orders: [] },
        message: 'No orders missing designs found.',
      });
    }

    // Fire-and-forget: trigger generation for each order.
    // The backend queue (AUTO_GEN_CONCURRENCY) limits how many run at once.
    for (const order of missingOrders) {
      triggerAutoDesignGeneration(String(order._id), 'auto_admin').catch((err) => {
        console.error(
          `[retry-missing-designs] Failed for order ${order.orderNumber}:`,
          err instanceof Error ? err.message : err,
        );
      });
    }

    return NextResponse.json({
      success: true,
      data: {
        queuedCount: missingOrders.length,
        orders: missingOrders.map((o) => ({
          _id: String(o._id),
          orderNumber: o.orderNumber,
          status: o.status,
          source: o.source,
        })),
      },
      message: `Queued ${missingOrders.length} order(s) for design generation.`,
    });
  } catch (error) {
    console.error('[retry-missing-designs] Error:', error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to retry missing designs',
      },
      { status: 500 },
    );
  }
}
