import { NextResponse } from 'next/server';
import { requireAdminPageAccess } from '@/lib/auth';
import {
  cancelAutoDesignGeneration,
  isAutoDesignCancelled,
} from '@/lib/services/auto-design-generation';

/**
 * POST /api/admin/orders/cancel-design-generation
 *
 * Cancels all pending auto-design-generation tasks that are waiting
 * in the backend queue. Tasks already in progress (actively calling
 * the design app) will finish naturally — they can't be aborted, but
 * no new tasks will start from the queue.
 *
 * Returns how many queued tasks were drained.
 */
export async function POST() {
  const auth = await requireAdminPageAccess(['orders', 'orderDesignLogs']);
  if ('error' in auth) return auth.error;

  try {
    const { drained } = cancelAutoDesignGeneration();

    return NextResponse.json({
      success: true,
      data: {
        drained,
        alreadyCancelled: isAutoDesignCancelled() && drained === 0,
      },
      message:
        drained > 0
          ? `Cancelled ${drained} pending task(s). In-progress tasks will finish naturally.`
          : 'No pending tasks in queue. In-progress tasks will finish naturally.',
    });
  } catch (error) {
    console.error('[cancel-design-generation] Error:', error);
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : 'Failed to cancel design generation',
      },
      { status: 500 },
    );
  }
}
