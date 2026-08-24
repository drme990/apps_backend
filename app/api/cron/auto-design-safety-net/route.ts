import { NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import Order from '@/lib/models/Order';
import OrderDesignLog from '@/lib/models/OrderDesignLog';
import { triggerAutoDesignGeneration } from '@/lib/services/auto-design-generation';

/**
 * GET /api/cron/auto-design-safety-net
 *
 * Safety-net cron that catches paid orders which slipped through the
 * normal auto-design-generation flow (e.g. serverless timeout killed
 * the fire-and-forget promise before it could call the design app).
 *
 * Finds orders that:
 *   1. Have a paid-like status (paid, partial-paid, completed)
 *   2. Have NO design URLs
 *   3. Have NO design log entry in the last 30 minutes (avoids
 *      re-triggering orders that are currently being processed or
 *      that just failed — they'll have a log entry already)
 *
 * For each such order, triggers auto-design generation and logs it.
 *
 * Recommended cron interval: every 10-15 minutes.
 *
 * Authentication: none (intended to be called by a cron scheduler or
 * Docker healthcheck). Protect with a network-level restriction or
 * add a shared-secret header check if exposed publicly.
 */
export async function GET(request: Request) {
  try {
    // Simple shared-secret check via header (optional)
    const cronSecret = process.env.CRON_SECRET;
    if (cronSecret) {
      const provided = request.headers.get('x-cron-secret');
      if (provided !== cronSecret) {
        return NextResponse.json(
          { success: false, error: 'Unauthorized' },
          { status: 401 },
        );
      }
    }

    await connectDB();

    // Find paid orders with no designs
    const paidOrdersWithoutDesigns = await Order.find({
      status: { $in: ['paid', 'partial-paid', 'completed'] },
      $or: [
        { designUrls: { $exists: false } },
        { designUrls: { $size: 0 } },
        { designUrls: null },
      ],
    })
      .select('_id orderNumber status source designUrls createdAt')
      .lean();

    if (paidOrdersWithoutDesigns.length === 0) {
      return NextResponse.json({
        success: true,
        message: 'No orders need design generation',
        checked: 0,
        triggered: 0,
      });
    }

    const orderIds = paidOrdersWithoutDesigns.map((o) => String(o._id));

    // Exclude orders that have a design log entry in the last 30 minutes
    // — they're either currently being processed or just failed (and
    // already have a log entry explaining why).
    const recentCutoff = new Date(Date.now() - 30 * 60 * 1000);
    const recentLogOrderIds = await OrderDesignLog.distinct('orderId', {
      orderId: { $in: orderIds },
      startedAt: { $gte: recentCutoff },
    });

    const recentLogSet = new Set(
      recentLogOrderIds.map((id) => String(id)),
    );

    // Orders that need generation: no designs AND no recent log
    const needsGeneration = paidOrdersWithoutDesigns.filter(
      (o) => !recentLogSet.has(String(o._id)),
    );

    if (needsGeneration.length === 0) {
      return NextResponse.json({
        success: true,
        message: 'All paid orders without designs have recent log entries',
        checked: paidOrdersWithoutDesigns.length,
        triggered: 0,
      });
    }

    console.log(
      `[safety-net] Found ${needsGeneration.length} paid order(s) without designs and without recent logs. Triggering generation...`,
    );

    // Trigger generation for each — fire-and-forget
    for (const order of needsGeneration) {
      console.log(
        `[safety-net] Triggering design generation for order ${order.orderNumber} (status: ${order.status})`,
      );
      triggerAutoDesignGeneration(String(order._id), 'auto_admin').catch(
        (err) => {
          console.error(
            `[safety-net] Auto design generation failed for order ${order.orderNumber}:`,
            err instanceof Error ? err.message : err,
          );
        },
      );
    }

    return NextResponse.json({
      success: true,
      message: `Triggered design generation for ${needsGeneration.length} order(s)`,
      checked: paidOrdersWithoutDesigns.length,
      triggered: needsGeneration.length,
      orders: needsGeneration.map((o) => ({
        orderNumber: o.orderNumber,
        status: o.status,
      })),
    });
  } catch (error) {
    console.error('Error in auto-design safety-net cron:', error);
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to run safety-net check',
      },
      { status: 500 },
    );
  }
}
