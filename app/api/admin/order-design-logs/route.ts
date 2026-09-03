import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import OrderDesignLog from '@/lib/models/OrderDesignLog';

/**
 * GET /api/admin/order-design-logs
 *
 * Returns paginated design generation logs with optional filters.
 *
 * Query params:
 *   - page     — page number (default 1)
 *   - limit    — page size (default 25, max 200)
 *   - status   — filter by overall status: success | partial | failed | skipped
 *   - trigger  — filter by trigger: auto_webhook | auto_admin | manual_admin
 *   - orderId  — filter by order ID
 *   - search   — search by order number (partial match)
 */
export async function GET(request: NextRequest) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess(['orders', 'activityLogs', 'orderDesignLogs']);
    if ('error' in auth) return auth.error;

    const { searchParams } = request.nextUrl;
    const page = Math.max(1, parseInt(searchParams.get('page') || '1'));
    const limit = Math.min(200, Math.max(1, parseInt(searchParams.get('limit') || '25')));
    const skip = (page - 1) * limit;

    const filter: Record<string, unknown> = {};

    const status = searchParams.get('status');
    if (status && ['success', 'partial', 'failed', 'skipped'].includes(status)) {
      filter.status = status;
    }

    const trigger = searchParams.get('trigger');
    if (trigger && ['auto_webhook', 'auto_admin', 'auto_cron', 'manual_admin'].includes(trigger)) {
      filter.trigger = trigger;
    }

    const orderId = searchParams.get('orderId');
    if (orderId) {
      filter.orderId = orderId;
    }

    const search = searchParams.get('search');
    if (search && search.trim()) {
      filter.orderNumber = { $regex: search.trim(), $options: 'i' };
    }

    const [logs, total] = await Promise.all([
      OrderDesignLog.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      OrderDesignLog.countDocuments(filter),
    ]);

    const totalPages = Math.ceil(total / limit);

    return NextResponse.json({
      success: true,
      data: {
        logs,
        pagination: {
          page,
          limit,
          total,
          totalPages,
          hasNextPage: page < totalPages,
          hasPrevPage: page > 1,
        },
      },
    });
  } catch (error) {
    console.error('Error fetching order design logs:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch design logs' },
      { status: 500 },
    );
  }
}
