import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAuth } from '@/lib/auth';
import Order, { type OrderStatus } from '@/lib/models/Order';
import { logActivity } from '@/lib/services/logger';

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
    const auth = await requireAuth();
    if ('error' in auth) return auth.error;

    const body = (await request.json()) as {
      orderIds?: string[];
      status?: string;
    };

    const orderIds = Array.isArray(body.orderIds)
      ? body.orderIds.filter(
          (id): id is string => typeof id === 'string' && id.trim().length > 0,
        )
      : [];
    const requestedStatus =
      typeof body.status === 'string' ? body.status.toLowerCase().trim() : '';
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

    const result = await Order.updateMany(
      { _id: { $in: orderIds } },
      { $set: { status: normalizedStatus } },
    );

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
