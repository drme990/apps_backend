/**
 * Design generation log service.
 *
 * Provides a helper to record a design generation attempt to the
 * OrderDesignLog collection. Called after each generation attempt
 * (both auto and manual) to create a persistent, queryable log entry.
 *
 * The log entry captures:
 *   - Who/what triggered it (webhook, admin status change, admin button)
 *   - The overall result (success, partial, failed, skipped)
 *   - Per-product results (success/failure, error codes, URLs)
 *   - Timing (started, finished, duration)
 *
 * This is best-effort: if the log write fails, we swallow the error
 * so it never affects the actual design generation flow.
 */

import OrderDesignLog, {
  type IOrderDesignLog,
  type IOrderDesignLogResult,
} from '@/lib/models/OrderDesignLog';

export type DesignGenTrigger = 'auto_webhook' | 'auto_admin' | 'auto_cron' | 'manual_admin';

export interface DesignGenLogInput {
  orderId: string;
  orderNumber: string;
  source?: string;
  orderStatus?: string;
  hasReservationPhoto?: boolean;
  trigger: DesignGenTrigger;
  startedAt: Date;
  finishedAt: Date;
  results: IOrderDesignLogResult[];
  triggeredByUserId?: string;
  triggeredByUserName?: string;
  triggeredByUserEmail?: string;
  /** Unexpected error that aborted the whole attempt */
  error?: string;
  /** Why the generation was skipped (order not found, not paid, already has designs, etc.) */
  skipReason?: string;
}

/**
 * Record a design generation attempt to the OrderDesignLog collection.
 *
 * Computes the overall status from the per-product results:
 *   - 0 total → 'skipped'
 *   - all success → 'success'
 *   - all failed → 'failed'
 *   - mixed → 'partial'
 *
 * Best-effort: errors are swallowed (logged to console only).
 */
export async function recordDesignGenLog(
  input: DesignGenLogInput,
): Promise<void> {
  try {
    const totalProducts = input.results.length;
    const generatedCount = input.results.filter((r) => r.success).length;
    const failedCount = totalProducts - generatedCount;

    let status: IOrderDesignLog['status'];
    if (input.skipReason) {
      status = 'skipped';
    } else if (input.error) {
      status = 'failed';
    } else if (totalProducts === 0) {
      status = 'skipped';
    } else if (generatedCount === totalProducts) {
      status = 'success';
    } else if (failedCount === totalProducts) {
      status = 'failed';
    } else {
      status = 'partial';
    }

    const durationMs = input.finishedAt.getTime() - input.startedAt.getTime();

    await OrderDesignLog.create({
      orderId: input.orderId,
      orderNumber: input.orderNumber,
      source: input.source,
      orderStatus: input.orderStatus,
      hasReservationPhoto: input.hasReservationPhoto,
      trigger: input.trigger,
      status,
      totalProducts,
      generatedCount,
      failedCount,
      results: input.results,
      triggeredByUserId: input.triggeredByUserId,
      triggeredByUserName: input.triggeredByUserName,
      triggeredByUserEmail: input.triggeredByUserEmail,
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
      durationMs,
      error: input.error,
      skipReason: input.skipReason,
    });
  } catch (error) {
    // Best-effort — don't let logging failures break design generation
    console.error(
      '[recordDesignGenLog] Failed to write design log:',
      error instanceof Error ? error.message : error,
    );
  }
}
