import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import Order, { type OrderStatus } from '@/lib/models/Order';
import { resolveWhatsappButtonState } from '@/lib/services/whatsapp-button-state';
import { logActivity } from '@/lib/services/logger';
import { parseJsonBody } from '@/lib/validation/http';
import { bulkOrderStatusSchema } from '@/lib/validation/schemas';
import { renumberExecutionDay } from '@/lib/services/execution-number';

const BULK_ALLOWED_STATUSES: ReadonlySet<OrderStatus> = new Set([
  'completed',
  'refunded',
  'cancelled',
]);

const STATUS_ALIASES: Record<string, OrderStatus> = {
  completed: 'completed',
  cancelled: 'cancelled',
  canceled: 'cancelled',
  cancel: 'cancelled',
  canceld: 'cancelled',
  refunded: 'refunded',
  refounded: 'refunded',
  refoudned: 'refunded',
};

export async function PUT(request: NextRequest) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess('orders');
    if ('error' in auth) return auth.error;

    const parsed = await parseJsonBody(request, bulkOrderStatusSchema);
    if (!parsed.success) return parsed.response;

    const orderIds = Array.isArray(parsed.data.orderIds)
      ? parsed.data.orderIds.filter(
        (id): id is string => typeof id === 'string' && id.trim().length > 0,
      )
      : [];
    const requestedStatus =
      typeof parsed.data.status === 'string'
        ? parsed.data.status.toLowerCase().trim()
        : '';
    const normalizedStatus = STATUS_ALIASES[requestedStatus];

    if (orderIds.length === 0) {
      return NextResponse.json(
        { success: false, error: 'No orders selected' },
        { status: 400 },
      );
    }

    if (!normalizedStatus || !BULK_ALLOWED_STATUSES.has(normalizedStatus)) {
      return NextResponse.json(
        { success: false, error: 'Invalid bulk order status' },
        { status: 400 },
      );
    }

    // Fetch the execution dates of the orders being moved out of
    // paid/partial-paid so we can renumber those days afterwards.
    // updateMany bypasses Mongoose hooks, so we handle renumbering here.
    const affectedOrders = await Order.find(
      {
        _id: { $in: orderIds },
        status: { $in: ['paid', 'partial-paid'] },
      },
      { reservationData: 1 },
    ).lean();

    const affectedDates = new Set<string>();
    for (const order of affectedOrders) {
      const dateField = (
        order.reservationData as Array<{ key: string; value: string }> | undefined
      )?.find((f) => f.key === 'executionDate');
      if (dateField && /^\d{4}-\d{2}-\d{2}$/.test(dateField.value)) {
        affectedDates.add(dateField.value);
      }
    }

    const result = await Order.updateMany(
      { _id: { $in: orderIds }, status: { $ne: normalizedStatus } },
      {
        $set: {
          status: normalizedStatus,
          isWhatsappButtonClicked: resolveWhatsappButtonState(normalizedStatus),
        },
      },
    );

    // Renumber each affected execution date so remaining orders have a
    // clean 1..N sequence with no gaps.
    for (const date of affectedDates) {
      await renumberExecutionDay(date);
    }

    await logActivity({
      userId: auth.user.userId,
      userName: auth.user.name,
      userEmail: auth.user.email,
      action: 'update',
      resource: 'order',
      details: `Bulk updated ${result.modifiedCount} orders to status ${normalizedStatus}`,
    });

    return NextResponse.json({
      success: true,
      data: {
        updatedCount: result.modifiedCount,
        matchedCount: result.matchedCount,
        status: normalizedStatus,
      },
    });
  } catch (error) {
    console.error('Error bulk updating orders:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to bulk update orders' },
      { status: 500 },
    );
  }
}
