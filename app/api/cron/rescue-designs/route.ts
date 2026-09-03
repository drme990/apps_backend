import { NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import Booking from '@/lib/models/Booking';
import Order from '@/lib/models/Order';
import OrderDesignLog from '@/lib/models/OrderDesignLog';
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
 * Logging:
 *   Every cron run writes a summary entry to `OrderDesignLog` with
 *   trigger='auto_cron' so it appears in the admin panel's "Order
 *   Design Logs" page. This includes runs that found 0 orphans — the
 *   admin can see that the cron is alive and working.
 *   Each individual order generation also writes its own log entry
 *   (via `triggerAutoDesignGeneration` → `recordDesignGenLog`).
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
  const startedAt = new Date();

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
    const baseFilter = {
      status: { $in: ['paid', 'partial-paid', 'completed'] },
      'reservationData.key': 'executionDate',
      'reservationData.value': tomorrow,
    };

    // Diagnostic: count ALL paid orders with tomorrow's execution date
    // (regardless of design status) so we can see if the issue is
    // "no orders at all" vs "all orders already have designs".
    const totalWithExecutionDate = await Order.countDocuments(baseFilter);

    const orphans = await Order.find({
      ...baseFilter,
      $expr: {
        $lt: [
          { $size: { $ifNull: ['$designUrls', []] } },
          {
            $size: {
              $filter: {
                input: { $ifNull: ['$items', []] },
                as: 'it',
                cond: { $ne: ['$$it.productId', null] },
              },
            },
          },
        ],
      },
    })
      .select('_id orderNumber status designUrls items source')
      .limit(20)
      .lean();

    console.log(
      `[cron/rescue-designs] Found ${orphans.length} orphaned order(s) for executionDate=${tomorrow}` +
      ` (total paid orders with this executionDate: ${totalWithExecutionDate})`,
    );

    // If we found 0 orphans but there ARE orders with this execution
    // date, log a sample so we can debug why they're not orphaned.
    if (orphans.length === 0 && totalWithExecutionDate > 0) {
      const samples = await Order.find(baseFilter)
        .select('orderNumber status designUrls items')
        .limit(3)
        .lean();
      for (const s of samples) {
        const dCount = (s.designUrls || []).length;
        const iCount = (s.items || []).filter((i) => i.productId).length;
        console.log(
          `[cron/rescue-designs] Sample order ${s.orderNumber}: status=${s.status}, designs=${dCount}, itemsWithProductId=${iCount}`,
        );
      }
    }

    // ── Trigger generation for each orphan (awaited, not fire-and-forget) ──
    // Unlike the webhook path (where Vercel kills the promise), here we
    // AWAIT each generation so that:
    //   1. The per-order log entries are written before the cron responds
    //   2. The cron summary log accurately reflects success/failure
    //
    // On the VPS backend (Docker), the process stays alive so awaiting
    // is safe. On Vercel, the cron function has a maxDuration — if it
    // times out, the cron runs again in 30 min and retries (the per-order
    // logs from the timed-out run may not be written, but the summary
    // log will reflect the partial completion).
    const results: Array<{
      orderNumber: string;
      orderId: string;
      success: boolean;
      error?: string;
    }> = [];

    for (const order of orphans) {
      const orderId = String(order._id);
      const designCount = (order.designUrls || []).length;
      const itemCount = (order.items || []).filter((i) => i.productId).length;
      console.log(
        `[cron/rescue-designs] Triggering generation for order ${order.orderNumber} (status=${order.status}, designs=${designCount}/${itemCount})`,
      );
      try {
        await triggerAutoDesignGeneration(orderId, 'auto_cron');
        results.push({
          orderNumber: order.orderNumber,
          orderId,
          success: true,
        });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(
          `[cron/rescue-designs] Generation failed for order ${order.orderNumber}:`,
          errMsg,
        );
        results.push({
          orderNumber: order.orderNumber,
          orderId,
          success: false,
          error: errMsg,
        });
      }
    }

    const succeeded = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;
    const duration = Date.now() - startTime;

    console.log(
      `[cron/rescue-designs] Done: ${succeeded} succeeded, ${failed} failed, ${orphans.length} total in ${duration}ms`,
    );

    // ── Write cron summary log to OrderDesignLog ───────────────────
    // This ensures every cron run is visible in the admin panel's
    // "Order Design Logs" page — even runs that found 0 orphans.
    // The admin can filter by trigger='auto_cron' to see cron activity.
    try {
      const summaryStatus =
        orphans.length === 0
          ? 'skipped'
          : failed === 0
            ? 'success'
            : succeeded === 0
              ? 'failed'
              : 'partial';

      const skipReason =
        orphans.length === 0
          ? totalWithExecutionDate > 0
            ? `Cron scan: 0 orphans found for executionDate=${tomorrow}, but ${totalWithExecutionDate} paid order(s) exist with this date (all have complete designs)`
            : `Cron scan: no paid orders found for executionDate=${tomorrow}`
          : undefined;

      const errorReason =
        failed > 0 && succeeded === 0
          ? `All ${failed} order(s) failed: ${results.filter((r) => !r.success).map((r) => `${r.orderNumber} (${r.error})`).join(', ')}`
          : undefined;

      await OrderDesignLog.create({
        orderId: 'cron-summary',
        orderNumber: `CRON ${tomorrow}`,
        source: 'cron',
        trigger: 'auto_cron',
        status: summaryStatus,
        totalProducts: orphans.length,
        generatedCount: succeeded,
        failedCount: failed,
        results: results.map((r) => ({
          productId: r.orderId,
          productName: r.orderNumber,
          success: r.success,
          errorCode: r.success ? undefined : 'cronRescueFailed',
          errorMessage: r.error,
        })),
        startedAt,
        finishedAt: new Date(),
        durationMs: duration,
        skipReason,
        error: errorReason,
      });
    } catch (logErr) {
      // Best-effort — don't let logging failure break the cron response
      console.error(
        '[cron/rescue-designs] Failed to write summary log:',
        logErr instanceof Error ? logErr.message : logErr,
      );
    }

    return NextResponse.json({
      success: true,
      message:
        orphans.length === 0
          ? `No orphaned orders found for executionDate=${tomorrow} (total paid with this date: ${totalWithExecutionDate})`
          : `Rescued ${succeeded}/${orphans.length} order(s) (${failed} failed)`,
      executionDate: tomorrow,
      egyptToday: today,
      found: orphans.length,
      totalWithExecutionDate,
      triggered: results.length,
      succeeded,
      failed,
      results,
      duration,
    });
  } catch (error) {
    const duration = Date.now() - startTime;
    console.error('[cron/rescue-designs] Error:', error);

    // Write an error summary log so the admin can see cron failures
    try {
      await OrderDesignLog.create({
        orderId: 'cron-summary',
        orderNumber: 'CRON ERROR',
        source: 'cron',
        trigger: 'auto_cron',
        status: 'failed',
        totalProducts: 0,
        generatedCount: 0,
        failedCount: 0,
        results: [],
        startedAt,
        finishedAt: new Date(),
        durationMs: duration,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    } catch {
      // Best-effort
    }

    return NextResponse.json(
      {
        success: false,
        error: 'Failed to rescue designs',
        message: error instanceof Error ? error.message : 'Unknown error',
        duration,
      },
      { status: 500 },
    );
  }
}
