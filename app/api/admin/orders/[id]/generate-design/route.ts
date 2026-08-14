import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import Order, { type IOrder } from '@/lib/models/Order';
import { logActivity } from '@/lib/services/logger';
import { generateDesignsForOrder } from '@/lib/services/design-generation-core';
import { recordDesignGenLog } from '@/lib/services/design-log-service';

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/admin/orders/[id]/generate-design
 *
 * Triggers design generation for an order. For each product in the order,
 * the backend calls the design app, which renders the matching booking
 * template and uploads the JPG to R2.
 *
 * The actual generation logic lives in `design-generation-core.ts` and is
 * shared with the auto-trigger (payment webhook / admin status change).
 * This ensures the manual button and the auto path behave identically.
 *
 * Response:
 *   200 — { success: true, data: { orderNumber, generated, skipped } }
 *   401/403 — auth failure
 *   404 — order not found
 *   500 — server error
 */
export async function POST(_request: NextRequest, { params }: RouteParams) {
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

    const startedAt = new Date();

    // ── Generate designs (shared core — same logic as the auto trigger)
    const { generated, skipped, logResults, hasReservationPhoto } =
      await generateDesignsForOrder(order);

    // ── Log the action (best-effort)
    try {
      await logActivity({
        action: 'generate_design',
        resource: 'order',
        resourceId: String(order._id),
        userId: auth.user.userId,
        userName: auth.user.name,
        userEmail: auth.user.email,
        details: JSON.stringify({
          orderNumber: order.orderNumber,
          generatedCount: generated.length,
          skippedCount: skipped.length,
          hasReservationPhoto,
        }),
      });
    } catch (logError) {
      console.error('[generate-design] logActivity failed:', logError);
    }

    // ── Record design generation log
    await recordDesignGenLog({
      orderId: String(order._id),
      orderNumber: order.orderNumber,
      source: order.source,
      orderStatus: order.status,
      hasReservationPhoto,
      trigger: 'manual_admin',
      startedAt,
      finishedAt: new Date(),
      results: logResults,
      triggeredByUserId: auth.user.userId,
      triggeredByUserName: auth.user.name,
      triggeredByUserEmail: auth.user.email,
    });

    return NextResponse.json({
      success: true,
      data: {
        orderNumber: order.orderNumber,
        generated,
        skipped,
      },
    });
  } catch (error) {
    console.error('[POST /api/admin/orders/[id]/generate-design]', error);
    return NextResponse.json(
      {
        success: false,
        error: {
          code: 'internalError',
          message: 'Failed to generate design',
        },
      },
      { status: 500 },
    );
  }
}
