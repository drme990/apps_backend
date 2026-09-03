import { NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import Booking from '@/lib/models/Booking';
import Order from '@/lib/models/Order';
import { getEgyptToday, addDays } from '@/lib/execution-date';
import { triggerAutoDesignGeneration } from '@/lib/services/auto-design-generation';

/**
 * GET /api/cron/rescue-designs
 *
 * Cron job that runs every 30 minutes (configured in vercel.json) to
 * rescue orders that are paid but missing some or all of their designs.
 *
 * Scope rule (CRITICAL):
 *   The cron ONLY targets orders whose `executionDate` is **tomorrow**
 *   (the next execution day from today). We deliberately do NOT generate
 *   designs for orders whose execution date has passed — the design is
 *   no longer needed by then. Existing designs on old orders are kept
 *   as-is; we never create new ones retroactively.
 *
 *   Example: cron runs on 2026-09-03 → looks for orders with
 *   executionDate === '2026-09-04' only.
 *
 * Why tomorrow and not today?
 *   Designs are needed *before* the execution day so they're ready when
 *   the order is processed. Targeting tomorrow gives the cron a full day
 *   of runs (every 30 min = ~48 runs) to generate designs for the next
 *   day's orders. By the time the execution day arrives, the designs
 *   are already done.
 *
 * This rescues orders where the primary auto-generation trigger failed
 * (e.g. fire-and-forget promise killed on Vercel serverless — see
 * auto_generate_design.md Bug #1).
 *
 * Auth: Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`.
 * The route refuses all requests if CRON_SECRET is not configured.
 */
export async function GET(request: Request) {
  // ── Auth ──────────────────────────────────────────────────────────
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    console.error('[cron/rescue-designs] CRON_SECRET is not configured');
    return NextResponse.json(
      { success: false, error: 'Cron secret not configured' },
      { status: 503 },
    );
  }
  if (authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json(
      { success: false, error: 'Unauthorized' },
      { status: 401 },
    );
  }

  const startTime = Date.now();

  try {
    await connectDB();

    // ── Compute tomorrow's date in Egypt time ──────────────────────
    // Execution dates are assigned in Egypt time (UTC+2 standard /
    // UTC+3 summer). The summer-time toggle is stored on the Booking
    // document — read it so the cron matches how dates were assigned.
    const booking = await Booking.findOne({ key: 'global' })
      .select('summerTimeEnabled')
      .lean();
    const summerTime = booking?.summerTimeEnabled === true;
    const today = getEgyptToday(summerTime);
    const tomorrow = addDays(today, 1);

    console.log(
      `[cron/rescue-designs] Scanning for paid orders with executionDate=${tomorrow} (Egypt today=${today})`,
    );

    // ── Find orphaned orders ───────────────────────────────────────
    // An order is "orphaned" if:
    //   1. Status is paid-like (paid, partial-paid, completed)
    //   2. executionDate === tomorrow
    //   3. designUrls is empty OR has fewer entries than items with a
    //      productId (partial — some products have designs, others
    //      don't)
    //
    // The $expr compares the count of designUrls against the count of
    // items that have a productId. Custom items (no productId) are
    // excluded — they never get designs.
    const orphans = await Order.find({
      status: { $in: ['paid', 'partial-paid', 'completed'] },
      'reservationData.key': 'executionDate',
      'reservationData.value': tomorrow,
      $expr: {
        $lt: [
          { $size: { $ifNull: ['$designUrls', []] } },
          {
            $size: {
              $filter: {
                input: { $ifNull: ['$items', []] },
                as: 'it',
                cond: {
                  $and: [
                    { $ifNull: ['$$it.productId', false] },
                    { $ne: ['$$it.productId', null] },
                  ],
                },
              },
            },
          },
        ],
      },
    })
      .select('_id orderNumber status designUrls items')
      .limit(20)
      .lean();

    console.log(
      `[cron/rescue-designs] Found ${orphans.length} orphaned order(s) for executionDate=${tomorrow}`,
    );

    if (orphans.length === 0) {
      return NextResponse.json({
        success: true,
        message: 'No orphaned orders found',
        executionDate: tomorrow,
        found: 0,
        triggered: 0,
        duration: Date.now() - startTime,
      });
    }

    // ── Trigger generation for each orphan ─────────────────────────
    // triggerAutoDesignGeneration is fire-and-forget on the webhook
    // path (where Vercel kills the promise), but here we're in a cron
    // route. On the VPS backend (Docker), the process stays alive so
    // the generation completes. On Vercel, the cron function has a
    // maxDuration — we fire-and-forget here too, but the cron runs
    // every 30 min so orphans are retried on the next run if this
    // invocation is killed before completion.
    let triggered = 0;
    for (const order of orphans) {
      const orderId = String(order._id);
      const designCount = (order.designUrls || []).length;
      const itemCount = (order.items || []).filter((i) => i.productId).length;
      console.log(
        `[cron/rescue-designs] Triggering generation for order ${order.orderNumber} (status=${order.status}, designs=${designCount}/${itemCount})`,
      );
      triggerAutoDesignGeneration(orderId, 'auto_admin').catch((err) => {
        console.error(
          `[cron/rescue-designs] Generation failed for order ${order.orderNumber}:`,
          err instanceof Error ? err.message : err,
        );
      });
      triggered++;
    }

    console.log(
      `[cron/rescue-designs] Triggered generation for ${triggered}/${orphans.length} order(s) in ${Date.now() - startTime}ms`,
    );

    return NextResponse.json({
      success: true,
      message: `Triggered design generation for ${triggered} orphaned order(s)`,
      executionDate: tomorrow,
      found: orphans.length,
      triggered,
      duration: Date.now() - startTime,
    });
  } catch (error) {
    console.error('[cron/rescue-designs] Error:', error);
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to rescue designs',
        message: error instanceof Error ? error.message : 'Unknown error',
        duration: Date.now() - startTime,
      },
      { status: 500 },
    );
  }
}
