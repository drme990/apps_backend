import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import Order, { type IOrder, type OrderStatus } from '@/lib/models/Order';
import OrderChangeHistory, { type IOrderChangeHistory } from '@/lib/models/OrderChangeHistory';
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

function normalizeInvoiceUrls(
  invoiceUrls?: Array<{ url: string; reviewed?: boolean; trusted?: boolean }>,
): Array<{ url: string; reviewed: boolean }> {
  return (invoiceUrls || []).map((invoice) => ({
    url: invoice.url,
    reviewed: invoice.reviewed ?? invoice.trusted ?? false,
  }));
}

function sanitizeOrderForAdmin(order: {
  easykashRef?: unknown;
  easykashProductCode?: unknown;
  easykashVoucher?: unknown;
  easykashResponse?: unknown;
  invoiceUrls?: Array<{ url: string; reviewed?: boolean; trusted?: boolean }>;
  [key: string]: unknown;
}) {
  const sanitized = { ...order };
  delete sanitized.easykashRef;
  delete sanitized.easykashProductCode;
  delete sanitized.easykashVoucher;
  delete sanitized.easykashResponse;
  if (Array.isArray(sanitized.invoiceUrls)) {
    sanitized.invoiceUrls = normalizeInvoiceUrls(sanitized.invoiceUrls);
  }
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
      sendOrderConfirmationEmail(order.toObject() as IOrder).catch(() => { });
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

function getReservationValue(
  reservationData: Array<{ key?: string; value?: string }>,
  key: string,
): string | undefined {
  return reservationData.find((f) => f.key === key)?.value;
}

function updateReservationField(
  reservationData: Array<{ key: string; label: { ar: string; en: string }; type: string; value: string }>,
  key: string,
  value: string,
  label: { ar: string; en: string },
  type: string,
): Array<{ key: string; label: { ar: string; en: string }; type: string; value: string }> {
  const idx = reservationData.findIndex((f) => f.key === key);
  if (idx >= 0) {
    reservationData[idx].value = value;
  } else {
    reservationData.push({ key, label, type, value });
  }
  return reservationData;
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess('orders');
    if ('error' in auth) return auth.error;

    const { id } = await params;
    const body = await request.json().catch(() => ({}));

    const order = await Order.findById(id);
    if (!order) {
      return NextResponse.json(
        { success: false, error: 'Order not found' },
        { status: 404 },
      );
    }

    const reservationData = Array.isArray(order.reservationData)
      ? [...order.reservationData]
      : [];
    const changes: Array<{
      changeType: IOrderChangeHistory['changeType'];
      previousValue: string | null;
      newValue: string | null;
    }> = [];

    if (
      typeof body.sacrificeFor === 'string' &&
      body.sacrificeFor !== getReservationValue(reservationData, 'sacrificeFor')
    ) {
      const previousValue = getReservationValue(reservationData, 'sacrificeFor') || null;
      updateReservationField(reservationData, 'sacrificeFor', body.sacrificeFor, { ar: 'الذبيحة لأجل', en: 'Sacrifice For' }, 'text');
      changes.push({
        changeType: 'name',
        previousValue,
        newValue: body.sacrificeFor,
      });
    }

    if (
      typeof body.shortDuaa === 'string' &&
      body.shortDuaa !== getReservationValue(reservationData, 'shortDuaa')
    ) {
      const previousValue = getReservationValue(reservationData, 'shortDuaa') || null;
      updateReservationField(reservationData, 'shortDuaa', body.shortDuaa, { ar: 'الدعاء المختصر', en: 'Short Duaa' }, 'textarea');
      changes.push({
        changeType: 'duaa',
        previousValue,
        newValue: body.shortDuaa,
      });
    }

    if (
      typeof body.photo === 'string' &&
      body.photo !== getReservationValue(reservationData, 'photo')
    ) {
      const previousValue = getReservationValue(reservationData, 'photo') || null;
      updateReservationField(reservationData, 'photo', body.photo, { ar: 'الصورة', en: 'Photo' }, 'picture');
      changes.push({
        changeType: 'photo',
        previousValue,
        newValue: body.photo,
      });
    }

    if (
      typeof body.gender === 'string' &&
      body.gender !== getReservationValue(reservationData, 'gender')
    ) {
      const previousValue = getReservationValue(reservationData, 'gender') || null;
      updateReservationField(reservationData, 'gender', body.gender, { ar: 'الجنس', en: 'Gender' }, 'radio');
      changes.push({
        changeType: 'gender',
        previousValue,
        newValue: body.gender,
      });
    }

    if (
      typeof body.isAlive === 'string' &&
      body.isAlive !== getReservationValue(reservationData, 'isAlive')
    ) {
      const previousValue = getReservationValue(reservationData, 'isAlive') || null;
      updateReservationField(reservationData, 'isAlive', body.isAlive, { ar: 'الحالة', en: 'Status' }, 'radio');
      changes.push({
        changeType: 'isAlive',
        previousValue,
        newValue: body.isAlive,
      });
    }

    if (
      typeof body.intention === 'string' &&
      body.intention !== getReservationValue(reservationData, 'intention')
    ) {
      const previousValue = getReservationValue(reservationData, 'intention') || null;
      updateReservationField(reservationData, 'intention', body.intention, { ar: 'النية', en: 'Intention' }, 'select');
      changes.push({
        changeType: 'intention',
        previousValue,
        newValue: body.intention,
      });
    }

    if (Array.isArray(body.items) && body.items.length > 0) {
      const previousItems = JSON.stringify(order.items || []);
      const nextItems = body.items;
      if (JSON.stringify(nextItems) !== previousItems) {
        order.items = nextItems;
        changes.push({
          changeType: 'items',
          previousValue: previousItems,
          newValue: JSON.stringify(nextItems),
        });
      }
    }

    if (typeof body.invoiceUrl === 'string' && body.invoiceUrl.trim()) {
      const trimmedInvoiceUrl = body.invoiceUrl.trim();
      const reviewed = body.invoiceReviewed === true;
      if (!Array.isArray(order.invoiceUrls)) {
        order.invoiceUrls = [];
      }
      const alreadyExists = order.invoiceUrls.some((entry) => entry.url === trimmedInvoiceUrl);
      if (!alreadyExists) {
        const previousValue = JSON.stringify(order.invoiceUrls || []);
        order.invoiceUrls.push({ url: trimmedInvoiceUrl, reviewed });
        changes.push({
          changeType: 'invoice',
          previousValue,
          newValue: JSON.stringify(order.invoiceUrls),
        });
      }
    }

    if (Array.isArray(body.invoiceUrls)) {
      const nextInvoiceUrls = body.invoiceUrls
        .filter((entry: unknown) => entry && typeof (entry as { url?: string }).url === 'string')
        .map((entry: unknown) => ({
          url: (entry as { url: string }).url.trim(),
          reviewed: Boolean((entry as { reviewed?: unknown }).reviewed),
        }));
      const previousValue = JSON.stringify(order.invoiceUrls || []);
      if (JSON.stringify(nextInvoiceUrls) !== previousValue) {
        order.invoiceUrls = nextInvoiceUrls;
        changes.push({
          changeType: 'invoice',
          previousValue,
          newValue: JSON.stringify(nextInvoiceUrls),
        });
      }
    }

    if (changes.length === 0) {
      return NextResponse.json({
        success: true,
        data: sanitizeOrderForAdmin(order.toObject() as unknown as Record<string, unknown>),
        changed: false,
      });
    }

    order.reservationData = reservationData;
    await order.save();

    for (const change of changes) {
      await OrderChangeHistory.create({
        orderId: String(order._id),
        appId: order.source || 'ghadaq',
        changeType: change.changeType,
        previousValue: change.previousValue,
        newValue: change.newValue,
        changedByUserId: auth.user.userId,
        changedByUserName: auth.user.name,
        changedByUserEmail: auth.user.email,
      });
    }

    const changeLabels = changes.map((c) => c.changeType).join(', ');
    await logActivity({
      userId: auth.user.userId,
      userName: auth.user.name,
      userEmail: auth.user.email,
      action: 'update',
      resource: 'order',
      resourceId: order._id.toString(),
      details: `Updated order ${order.orderNumber}: ${changeLabels}`,
    });

    return NextResponse.json({
      success: true,
      data: sanitizeOrderForAdmin(order.toObject() as unknown as Record<string, unknown>),
      changed: true,
    });
  } catch (error) {
    console.error('Error patching order:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to update order' },
      { status: 500 },
    );
  }
}
