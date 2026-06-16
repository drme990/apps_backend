import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import Order, { type IOrder, type OrderStatus } from '@/lib/models/Order';
import { resolveWhatsappButtonState } from '@/lib/services/whatsapp-button-state';
import { logActivity } from '@/lib/services/logger';
import { sendOrderConfirmationEmail } from '@/lib/services/email';
import { parseJsonBody } from '@/lib/validation/http';
import { orderStatusUpdateSchema } from '@/lib/validation/schemas';

function touchStatusUpdateTime(order: { statusUpdateTime?: Date }): void {
  order.statusUpdateTime = new Date();
}

const ALLOWED_ORDER_STATUSES = new Set([
  'pending',
  'processing',
  'partial-paid',
  'paid',
  'completed',
  'failed',
  'refunded',
  'cancelled',
]);

const STATUS_ALIASES: Record<string, string> = {
  cancel: 'cancelled',
  canceled: 'cancelled',
  refounded: 'refunded',
};

function hasOrderUserId(userId: unknown): boolean {
  if (typeof userId === 'string') return userId.trim().length > 0;
  if (typeof userId === 'object' && userId !== null) return true;
  return false;
}

function sanitizeOrderForAdmin(order: {
  easykashRef?: unknown;
  easykashProductCode?: unknown;
  easykashVoucher?: unknown;
  easykashResponse?: unknown;
  [key: string]: unknown;
}) {
  const sanitized = { ...order };
  delete sanitized.easykashRef;
  delete sanitized.easykashProductCode;
  delete sanitized.easykashVoucher;
  delete sanitized.easykashResponse;
  return sanitized;
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess('orders');
    if ('error' in auth) return auth.error;

    const { id } = await params;
    const order = await Order.findById(id).lean();
    if (!order) {
      return NextResponse.json(
        { success: false, error: 'Order not found' },
        { status: 404 },
      );
    }

    const hasIsGuest = typeof order.isGuest === 'boolean';
    const hasUserId = hasOrderUserId(order.userId);
    const sanitizedOrder = sanitizeOrderForAdmin(
      order as unknown as {
        easykashRef?: unknown;
        easykashProductCode?: unknown;
        easykashVoucher?: unknown;
        easykashResponse?: unknown;
        [key: string]: unknown;
      },
    );

    return NextResponse.json({
      success: true,
      data: {
        ...sanitizedOrder,
        isGuest: hasIsGuest ? order.isGuest : !hasUserId,
      },
    });
  } catch (error) {
    console.error('Error fetching order:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch order' },
      { status: 500 },
    );
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess('orders');
    if ('error' in auth) return auth.error;

    const { id } = await params;
    const parsed = await parseJsonBody(request, orderStatusUpdateSchema);
    if (!parsed.success) return parsed.response;
    const { status, cancellationReason } = parsed.data;
    const rawStatus =
      typeof status === 'string' ? status.toLowerCase().trim() : '';
    const normalizedStatus = STATUS_ALIASES[rawStatus] || rawStatus;

    if (!normalizedStatus || !ALLOWED_ORDER_STATUSES.has(normalizedStatus)) {
      return NextResponse.json(
        { success: false, error: 'Invalid order status' },
        { status: 400 },
      );
    }

    const nextStatus = normalizedStatus as OrderStatus;

    const order = await Order.findById(id);
    if (!order) {
      return NextResponse.json(
        { success: false, error: 'Order not found' },
        { status: 404 },
      );
    }

    const changes: string[] = [];
    const previousStatus = order.status;
    const previousWhatsappState = order.isWhatsappButtonClicked;
    if (nextStatus !== order.status) {
      order.status = nextStatus;
      touchStatusUpdateTime(order);
      changes.push(`status → ${nextStatus}`);
    }

    if (
      nextStatus === 'cancelled' &&
      typeof cancellationReason === 'string' &&
      cancellationReason.trim().length > 0
    ) {
      order.cancellationReason = cancellationReason.trim();
      changes.push(`cancellationReason → ${cancellationReason.trim()}`);
    } else if (nextStatus !== 'cancelled' && order.cancellationReason) {
      order.cancellationReason = undefined;
      changes.push('cancellationReason → cleared');
    }

    const nextWhatsappState = resolveWhatsappButtonState(
      nextStatus,
      previousStatus,
      previousWhatsappState,
    );
    if (nextWhatsappState !== previousWhatsappState) {
      order.isWhatsappButtonClicked = nextWhatsappState;
      changes.push(`whatsapp → ${nextWhatsappState}`);
    }

    if (changes.length === 0) {
      const unchangedOrder = order.toObject() as unknown as {
        easykashRef?: unknown;
        easykashProductCode?: unknown;
        easykashVoucher?: unknown;
        easykashResponse?: unknown;
        [key: string]: unknown;
      };
      return NextResponse.json({
        success: true,
        data: sanitizeOrderForAdmin(unchangedOrder),
      });
    }

    await order.save();

    if (nextStatus === 'paid' && changes.includes('status → paid')) {
      sendOrderConfirmationEmail(order.toObject() as IOrder).catch(() => {});
    }

    await logActivity({
      userId: auth.user.userId,
      userName: auth.user.name,
      userEmail: auth.user.email,
      action: 'update',
      resource: 'order',
      resourceId: order._id.toString(),
      details: `Updated order ${order.orderNumber}: ${changes.join(', ')}`,
    });

    const updatedOrder = order.toObject() as unknown as {
      easykashRef?: unknown;
      easykashProductCode?: unknown;
      easykashVoucher?: unknown;
      easykashResponse?: unknown;
      [key: string]: unknown;
    };
    return NextResponse.json({
      success: true,
      data: sanitizeOrderForAdmin(updatedOrder),
    });
  } catch (error) {
    console.error('Error updating order:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to update order' },
      { status: 500 },
    );
  }
}
