import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import Order, { type IOrder, type IInvoiceUrl, type IPayment, type OrderStatus } from '@/lib/models/Order';
import OrderChangeHistory, { type IOrderChangeHistory } from '@/lib/models/OrderChangeHistory';
import { resolveWhatsappButtonState } from '@/lib/services/whatsapp-button-state';
import { logActivity } from '@/lib/services/logger';
import { sendOrderConfirmationEmail } from '@/lib/services/email';
import {
  evaluateAndTriggerAutoDesign,
  triggerDesignRegeneration,
} from '@/lib/services/auto-design-generation';
import { parseJsonBody } from '@/lib/validation/http';
import { orderStatusUpdateSchema } from '@/lib/validation/schemas';
import { calculateOrderFinancials } from '@/lib/services/order-financials';
import { convertCurrency } from '@/lib/services/currency';
import Booking from '@/lib/models/Booking';
import { recomputeExecutionDateOnInvoiceConfirmed } from '@/lib/execution-date';

/** Currencies supported by the EasyKash payment gateway. */
const EASYKASH_SUPPORTED_CURRENCIES = new Set(['SAR', 'EGP', 'USD', 'EUR']);

/**
 * Determines whether an invoice value covers the remaining amount,
 * optionally applying the `allowRate` tolerance configured on the
 * order's country.
 *
 * The equation is: invoiceValue + allowRate >= remaining
 *
 * - `percentage`: allowRate = remaining * (value/100)
 *   → paid when invoiceValue >= remaining * (1 - value/100)
 * - `fixnumber`:  allowRate = value
 *   → paid when invoiceValue >= remaining - value
 * - no allowRate: paid when invoiceValue >= remaining (exact)
 */
function isInvoiceWithinAllowRate(
  invoiceValue: number,
  remainingBefore: number,
  allowRate?: { type: 'percentage' | 'fixnumber'; value: number } | null,
): boolean {
  if (remainingBefore <= 0) return true;
  if (invoiceValue >= remainingBefore) return true;
  if (!allowRate || typeof allowRate.value !== 'number' || allowRate.value <= 0) {
    return false;
  }
  if (allowRate.type === 'percentage') {
    const threshold = remainingBefore * (1 - allowRate.value / 100);
    return invoiceValue >= threshold;
  }
  // fixnumber
  const threshold = remainingBefore - allowRate.value;
  return invoiceValue >= threshold;
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
  invoiceUrls?: Array<{
    url: string;
    invoiceStatus?: string;
    rejectionReason?: string;
    value?: number;
    currency?: string;
    deleted?: boolean;
  }>,
): Array<{
  url: string;
  invoiceStatus: 'confirmed' | 'waiting' | 'pending' | 'rejected' | 'deleted';
  rejectionReason: string;
  value: number;
  currency: string;
}> {
  const VALID_STATUSES = ['confirmed', 'waiting', 'pending', 'rejected', 'deleted'] as const;
  return (invoiceUrls || [])
    .map((invoice: {
      url: string;
      invoiceStatus?: string;
      rejectionReason?: string;
      value?: number;
      currency?: string;
    }) => {
      const invoiceStatus: 'confirmed' | 'waiting' | 'pending' | 'rejected' | 'deleted' =
        invoice.invoiceStatus && VALID_STATUSES.includes(invoice.invoiceStatus as (typeof VALID_STATUSES)[number])
          ? (invoice.invoiceStatus as (typeof VALID_STATUSES)[number])
          : 'waiting';
      return {
        url: invoice.url,
        invoiceStatus,
        rejectionReason: typeof invoice.rejectionReason === 'string' ? invoice.rejectionReason : '',
        value: typeof invoice.value === 'number' ? invoice.value : 0,
        currency: typeof invoice.currency === 'string' ? invoice.currency.trim() || 'EGP' : 'EGP',
      };
    });
}

function sanitizeOrderForAdmin(order: {
  easykashRef?: unknown;
  easykashProductCode?: unknown;
  easykashVoucher?: unknown;
  easykashResponse?: unknown;
  invoiceUrls?: Array<{
    url: string;
    invoiceStatus?: string;
    rejectionReason?: string;
    value?: number;
    currency?: string;
  }>;
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

/**
 * Build a human-readable summary of what changed between the previous
 * and next item arrays. Each item is shown as:
 *   "Product name (size) × qty @ price currency"
 * This is recorded in the order change history so admins can see
 * exactly what was edited at any point in time.
 */
function summarizeItemChanges(
  prev: IOrder['items'],
  next: IOrder['items'],
): { previous: string; next: string } {
  const formatItem = (item: IOrder['items'][number]): string => {
    const name = item.productName?.ar || item.productName?.en || item.productId || 'Unknown';
    const size = item.customSize || item.sizeName?.ar || item.sizeName?.en || '';
    const sizeStr = size ? ` (${size})` : '';
    const qty = item.quantity || 1;
    const price = item.price ?? 0;
    const currency = item.currency || '';
    return `${name}${sizeStr} × ${qty} @ ${price} ${currency}`.trim();
  };

  const formatList = (items: IOrder['items']): string =>
    items.map((item, i) => `${i + 1}. ${formatItem(item)}`).join('\n');

  return {
    previous: formatList(prev),
    next: formatList(next),
  };
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess(['orders', 'invoices', 'orderDesigns']);
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
    const auth = await requireAdminPageAccess(['orders', 'invoices', 'orderDesigns']);
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

    if (nextStatus !== previousStatus) {
      await OrderChangeHistory.create({
        orderId: String(order._id),
        appId: order.source || 'ghadaq',
        changeType: 'status',
        previousValue: previousStatus,
        newValue: nextStatus,
        changedByUserId: auth.user.userId,
        changedByUserName: auth.user.name,
        changedByUserEmail: auth.user.email,
      });
    }

    if (nextStatus === 'paid' && changes.includes('status → paid')) {
      sendOrderConfirmationEmail(order.toObject() as IOrder).catch(() => { });
    }

    // ── Auto design generation ──────────────────────────────────────
    // Evaluates whether design generation should be triggered and ALWAYS
    // logs the decision — even when the trigger is NOT called, so every
    // paid order has a traceable log entry. Fire-and-forget.
    evaluateAndTriggerAutoDesign(
      order.toObject(),
      previousStatus,
      'auto_admin',
    ).catch((err) => {
      console.error(
        `[admin PUT] Auto design evaluation failed for order ${order.orderNumber}:`,
        err instanceof Error ? err.message : err,
      );
    });

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
    const auth = await requireAdminPageAccess(['orders', 'invoices', 'orderDesigns']);
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
    // Track whether a whileCreating invoice was newly confirmed during
    // this PATCH — only the first invoice (uploaded during order creation)
    // should trigger an execution date recompute. Later invoices
    // (whileCreating=false, added via PATCH) must NOT change the date.
    let firstInvoiceNewlyConfirmed = false;

    // Track the last confirmed invoice's value and the remaining before it
    // was added — used for the allowRate tolerance check.
    let allowRateInvoiceValue: number | null = null;
    let allowRateRemainingBefore: number | null = null;

    // ── Helpers to manage payment entries linked to invoices ──
    // Every invoice uploaded to an order gets a payment entry in the
    // timeline with status 'pending'. When the invoice is confirmed,
    // the payment status is updated to 'paid' (with currency conversion).
    // When the invoice is rejected or deleted, the payment status is
    // set to 'failed'. This keeps the payment visible in the timeline
    // at all times so admins can track the invoice's lifecycle.
    const invoicePaymentId = (url: string) => `manual_invoice_${url.slice(-50)}`;

    // Create a pending payment entry for a newly uploaded invoice.
    // No currency conversion yet — that happens when the invoice is
    // confirmed and the payment transitions to 'paid'.
    const createInvoicePaymentPending = (
      invoice: IInvoiceUrl,
      paymentMethodOverride?: IPayment['paymentMethod'],
    ) => {
      // Skip invoices uploaded during order creation — their amount was
      // already accounted for via the manually-entered paidAmount field.
      if (invoice.whileCreating) return;
      if (!Array.isArray(order.payments)) order.payments = [];
      const pid = invoicePaymentId(invoice.url);
      // Don't add duplicate
      if (order.payments.some((p: IPayment) => p.paymentId === pid)) return;

      const invoiceCurrency = (invoice.currency || order.currency || 'EGP').toUpperCase();
      const pm = paymentMethodOverride || (order.paymentMethod || 'bank_transfer') as IPayment['paymentMethod'];

      order.payments.push({
        paymentId: pid,
        easykashOrderId: `manual-invoice-${invoice.url.slice(-50)}`,
        orderAmount: invoice.value,
        gatewayAmount: invoice.value,
        gatewayCurrency: invoiceCurrency,
        amount: invoice.value,
        currency: invoiceCurrency,
        status: 'pending',
        paymentMethod: pm,
        createdAt: new Date(),
      });
    };

    // Transition an invoice's payment to 'paid' status. If a pending
    // payment already exists, update it in-place (with currency conversion).
    // If no payment exists (e.g. legacy orders), create a new 'paid' entry.
    const confirmInvoicePayment = async (
      invoice: IInvoiceUrl,
      paymentMethodOverride?: IPayment['paymentMethod'],
    ) => {
      if (invoice.whileCreating) return;
      if (invoice.value <= 0) return;
      if (!Array.isArray(order.payments)) order.payments = [];
      const pid = invoicePaymentId(invoice.url);
      const idx = order.payments.findIndex((p: IPayment) => p.paymentId === pid);

      // Capture the remaining before this payment is added — used for
      // the allowRate tolerance check later.
      const { totalPaid: paidBefore, fullAmount } = calculateOrderFinancials(order);
      allowRateRemainingBefore = Math.max(0, fullAmount - paidBefore);

      const invoiceCurrency = (invoice.currency || order.currency || 'EGP').toUpperCase();
      const orderCurrency = (order.currency || 'EGP').toUpperCase();
      const pm = paymentMethodOverride || (order.paymentMethod || 'bank_transfer') as IPayment['paymentMethod'];

      // ── Currency conversion logic ──
      const gatewayCurrency = EASYKASH_SUPPORTED_CURRENCIES.has(orderCurrency)
        ? orderCurrency
        : 'EGP';

      let orderAmount = invoice.value;
      if (invoiceCurrency !== orderCurrency) {
        try {
          orderAmount = await convertCurrency(invoice.value, invoiceCurrency, orderCurrency);
        } catch {
          orderAmount = invoice.value;
        }
      }

      allowRateInvoiceValue = orderAmount;

      let gatewayAmount = orderAmount;
      if (orderCurrency !== gatewayCurrency) {
        try {
          gatewayAmount = await convertCurrency(orderAmount, orderCurrency, gatewayCurrency);
        } catch {
          gatewayAmount = orderAmount;
        }
      } else if (invoiceCurrency !== gatewayCurrency) {
        try {
          gatewayAmount = await convertCurrency(invoice.value, invoiceCurrency, gatewayCurrency);
        } catch {
          gatewayAmount = invoice.value;
        }
      }

      if (idx >= 0) {
        // Update existing pending payment to 'paid'
        const existing = order.payments[idx];
        existing.status = 'paid';
        existing.orderAmount = orderAmount;
        existing.gatewayAmount = gatewayAmount;
        existing.gatewayCurrency = gatewayCurrency;
        existing.paymentMethod = pm;
        existing.paidAt = new Date();
      } else {
        // Legacy: no pending payment exists, create a new 'paid' entry
        order.payments.push({
          paymentId: pid,
          easykashOrderId: `manual-invoice-${invoice.url.slice(-50)}`,
          orderAmount,
          gatewayAmount,
          gatewayCurrency,
          amount: invoice.value,
          currency: invoiceCurrency,
          status: 'paid',
          paymentMethod: pm,
          createdAt: new Date(),
          paidAt: new Date(),
        });
      }
      changes.push({
        changeType: 'payment',
        previousValue: null,
        newValue: JSON.stringify({ paidAmount: orderAmount, invoiceUrl: invoice.url, currency: orderCurrency, paymentMethod: pm, gatewayAmount, gatewayCurrency }),
      });
    };

    // Update an invoice's payment status (for reject → failed, un-confirm → pending).
    const setInvoicePaymentStatus = (
      invoice: IInvoiceUrl,
      status: 'pending' | 'failed' | 'expired',
    ) => {
      if (invoice.whileCreating) return;
      if (!Array.isArray(order.payments)) return;
      const pid = invoicePaymentId(invoice.url);
      const idx = order.payments.findIndex((p: IPayment) => p.paymentId === pid);
      if (idx >= 0) {
        const payment = order.payments[idx];
        const previousStatus = payment.status;
        payment.status = status;
        // This function only transitions to non-paid statuses, so always
        // clear paidAt (the 'paid' status is set by confirmInvoicePayment).
        payment.paidAt = undefined;
        changes.push({
          changeType: 'payment',
          previousValue: JSON.stringify({ status: previousStatus, invoiceUrl: invoice.url, amount: payment.amount }),
          newValue: JSON.stringify({ status, invoiceUrl: invoice.url, amount: payment.amount }),
        });
      }
    };

    // Update the linked payment's amounts when an invoice value/currency changes.
    // Only applies to confirmed invoices with an existing payment entry.
    const updateInvoicePaymentAmounts = async (invoice: IInvoiceUrl) => {
      if (invoice.whileCreating) return;
      if (!Array.isArray(order.payments)) return;
      const pid = invoicePaymentId(invoice.url);
      const idx = order.payments.findIndex((p: IPayment) => p.paymentId === pid);
      if (idx < 0) return;
      const payment = order.payments[idx];
      if (payment.status !== 'paid') return; // only update 'paid' payments

      const invoiceCurrency = (invoice.currency || order.currency || 'EGP').toUpperCase();
      const orderCurrency = (order.currency || 'EGP').toUpperCase();
      payment.amount = invoice.value;
      payment.currency = invoiceCurrency;

      // Recalculate orderAmount (invoice value → order currency)
      if (invoiceCurrency !== orderCurrency) {
        try {
          payment.orderAmount = await convertCurrency(invoice.value, invoiceCurrency, orderCurrency);
        } catch {
          payment.orderAmount = invoice.value;
        }
      } else {
        payment.orderAmount = invoice.value;
      }

      // Recalculate gatewayAmount (order currency → gateway currency)
      const gatewayCurrency = EASYKASH_SUPPORTED_CURRENCIES.has(orderCurrency)
        ? orderCurrency
        : 'EGP';
      if (orderCurrency !== gatewayCurrency) {
        try {
          payment.gatewayAmount = await convertCurrency(payment.orderAmount, orderCurrency, gatewayCurrency);
        } catch {
          payment.gatewayAmount = payment.orderAmount;
        }
      } else {
        payment.gatewayAmount = payment.orderAmount;
      }
    };

    if (
      typeof body.sacrificeFor === 'string' &&
      body.sacrificeFor !== getReservationValue(reservationData, 'sacrificeFor')
    ) {
      const previousValue = getReservationValue(reservationData, 'sacrificeFor') || null;
      updateReservationField(reservationData, 'sacrificeFor', body.sacrificeFor, { ar: 'المؤدى عنه', en: 'Sacrifice For' }, 'text');
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

    // ── Referral code ───────────────────────────────────────────
    if (
      typeof body.referralId === 'string' &&
      body.referralId !== (order.referralId || '')
    ) {
      // Validate that the new referral code belongs to the order's app
      if (body.referralId) {
        const { validateReferralCode } = await import('@/lib/services/referral-validation');
        const refValidation = await validateReferralCode(body.referralId, order.source);
        if (!refValidation.valid) {
          return NextResponse.json(
            { success: false, error: refValidation.message || 'Invalid referral code for this app' },
            { status: 400 },
          );
        }
      }
      const previousValue = order.referralId || null;
      order.referralId = body.referralId || undefined;
      changes.push({
        changeType: 'referral',
        previousValue,
        newValue: body.referralId || null,
      });
    }

    let itemsChanged = false;
    if (Array.isArray(body.items) && body.items.length > 0) {
      const prevItemsArr = order.items || [];
      const previousItems = JSON.stringify(prevItemsArr);
      const nextItems = body.items;
      if (JSON.stringify(nextItems) !== previousItems) {
        order.items = nextItems;
        itemsChanged = true;

        // Build a human-readable summary of what changed in the items
        // so the admin can see exactly what was edited in the order history.
        const itemSummary = summarizeItemChanges(prevItemsArr, nextItems);
        changes.push({
          changeType: 'items',
          previousValue: itemSummary.previous,
          newValue: itemSummary.next,
        });
      }
    }

    // ── Recalculate order total when items change ──
    // When the admin edits item prices, quantities, or swaps products,
    // the order's totalAmount and fullAmount must be recomputed so that
    // the paid/remaining amounts and status stay accurate.
    if (itemsChanged) {
      const orderCurrency = (order.currency || 'EGP').toUpperCase();
      let newTotal = 0;
      for (const item of order.items) {
        const itemCurrency = (item.currency || orderCurrency).toUpperCase();
        const itemSubtotal = (item.price || 0) * (item.quantity || 1);
        if (itemCurrency === orderCurrency) {
          newTotal += itemSubtotal;
        } else {
          try {
            newTotal += await convertCurrency(itemSubtotal, itemCurrency, orderCurrency);
          } catch {
            // If conversion fails, use the raw subtotal as fallback
            newTotal += itemSubtotal;
          }
        }
      }
      const previousTotal = order.fullAmount ?? order.totalAmount ?? 0;
      const roundedTotal = Math.round(newTotal * 100) / 100;
      if (roundedTotal !== previousTotal) {
        order.totalAmount = roundedTotal;
        order.fullAmount = roundedTotal;
        changes.push({
          changeType: 'totalAmount',
          previousValue: String(previousTotal),
          newValue: String(roundedTotal),
        });
        if (!Array.isArray(order.internalNotes)) {
          order.internalNotes = [];
        }
        order.internalNotes.push({
          text: `Order total changed from ${previousTotal} to ${roundedTotal} ${orderCurrency} due to item edit.`,
          author: 'system',
          createdAt: new Date(),
        });
      }
    }

    if (typeof body.invoiceUrl === 'string' && body.invoiceUrl.trim()) {
      const trimmedInvoiceUrl = body.invoiceUrl.trim();
      const value = typeof body.invoiceValue === 'number' ? body.invoiceValue : 0;
      const VALID_STATUSES = ['confirmed', 'waiting', 'pending', 'rejected', 'deleted'] as const;
      const rawStatus = body.invoiceStatus;
      const invoiceStatus =
        typeof rawStatus === 'string' && VALID_STATUSES.includes(rawStatus as (typeof VALID_STATUSES)[number])
          ? (rawStatus as (typeof VALID_STATUSES)[number])
          : 'waiting';
      const rejectionReason =
        typeof body.rejectionReason === 'string' ? body.rejectionReason.trim() : '';
      // Payment method selected by the admin in the upload modal
      const VALID_PAYMENT_METHODS = [
        'easykash', 'insta_pay', 'vodafone_cash', 'bank_transfer', 'paypal', 'binance',
        'card', 'wallet', 'fawry', 'meeza', 'valu', 'other',
      ] as const;
      const rawMethod = body.invoicePaymentMethod;
      const paymentMethod =
        typeof rawMethod === 'string' && VALID_PAYMENT_METHODS.includes(rawMethod as (typeof VALID_PAYMENT_METHODS)[number])
          ? (rawMethod as (typeof VALID_PAYMENT_METHODS)[number])
          : (order.paymentMethod || 'bank_transfer') as typeof VALID_PAYMENT_METHODS[number];
      // Invoice currency (may differ from order currency)
      const invoiceCurrency =
        typeof body.invoiceCurrency === 'string' && body.invoiceCurrency.trim()
          ? body.invoiceCurrency.trim().toUpperCase()
          : (order.currency || 'EGP').toUpperCase();
      if (!Array.isArray(order.invoiceUrls)) {
        order.invoiceUrls = [];
      }
      const alreadyExists = order.invoiceUrls.some((entry: IInvoiceUrl) => entry.url === trimmedInvoiceUrl);
      if (!alreadyExists) {
        const newEntry: IInvoiceUrl = { url: trimmedInvoiceUrl, invoiceStatus, rejectionReason, value, currency: invoiceCurrency };
        order.invoiceUrls.push(newEntry);
        changes.push({
          changeType: 'invoice',
          previousValue: null,
          newValue: JSON.stringify(newEntry),
        });

        // Track if this new invoice is confirmed AND was uploaded during
        // order creation (whileCreating). Only whileCreating invoices
        // trigger an execution date recompute.
        if (invoiceStatus === 'confirmed' && newEntry.whileCreating) {
          firstInvoiceNewlyConfirmed = true;
        }

        // ── Always create a payment entry for the uploaded invoice. ──
        //    The payment starts as 'pending'. If the invoice is uploaded
        //    directly as 'confirmed', transition it to 'paid' immediately.
        if (invoiceStatus === 'confirmed') {
          createInvoicePaymentPending(newEntry, paymentMethod);
          await confirmInvoicePayment(newEntry, paymentMethod);
        } else if (invoiceStatus === 'rejected') {
          createInvoicePaymentPending(newEntry, paymentMethod);
          setInvoicePaymentStatus(newEntry, 'failed');
        } else {
          createInvoicePaymentPending(newEntry, paymentMethod);
        }
      }
    }

    if (Array.isArray(body.invoiceUrls)) {
      const VALID_STATUSES = ['confirmed', 'waiting', 'pending', 'rejected', 'deleted'] as const;
      const previousInvoiceUrlsForLookup: IInvoiceUrl[] = Array.isArray(order.invoiceUrls) ? order.invoiceUrls : [];
      const previousByUrl = new Map(previousInvoiceUrlsForLookup.map((entry: IInvoiceUrl) => [entry.url, entry]));
      const nextInvoiceUrls: IInvoiceUrl[] = body.invoiceUrls
        .filter((entry: unknown) => entry && typeof (entry as { url?: string }).url === 'string')
        .map((entry: unknown) => {
          const rawStatus = (entry as { invoiceStatus?: unknown }).invoiceStatus;
          const invoiceStatus =
            typeof rawStatus === 'string' && VALID_STATUSES.includes(rawStatus as (typeof VALID_STATUSES)[number])
              ? (rawStatus as (typeof VALID_STATUSES)[number])
              : 'waiting';
          const url = (entry as { url: string }).url.trim();
          // Preserve whileCreating from the existing entry (if any).
          // New invoices uploaded via this path default to whileCreating=false.
          const prevEntry = previousByUrl.get(url);
          // ── Guard: once an invoice is 'deleted', its status is frozen. ──
          // Any attempt to change it to a different status is silently
          // ignored — the 'deleted' status is preserved.
          if (prevEntry && prevEntry.invoiceStatus === 'deleted' && invoiceStatus !== 'deleted') {
            return {
              url,
              invoiceStatus: 'deleted' as const,
              rejectionReason: prevEntry.rejectionReason || '',
              value: prevEntry.value,
              currency: prevEntry.currency || 'EGP',
              whileCreating: prevEntry.whileCreating ?? false,
            };
          }
          return {
            url,
            invoiceStatus,
            rejectionReason:
              typeof (entry as { rejectionReason?: unknown }).rejectionReason === 'string'
                ? (entry as { rejectionReason: string }).rejectionReason.trim()
                : '',
            value: typeof (entry as { value?: unknown }).value === 'number' ? (entry as { value: number }).value : 0,
            currency:
              typeof (entry as { currency?: unknown }).currency === 'string'
                ? (entry as { currency: string }).currency.trim() || 'EGP'
                : 'EGP',
            whileCreating: prevEntry?.whileCreating ?? false,
          };
        });
      const previousInvoiceUrls: IInvoiceUrl[] = Array.isArray(order.invoiceUrls) ? order.invoiceUrls : [];
      if (JSON.stringify(nextInvoiceUrls) !== JSON.stringify(previousInvoiceUrls)) {
        order.invoiceUrls = nextInvoiceUrls;

        if (previousInvoiceUrls.length === nextInvoiceUrls.length) {
          // Same length: compare entries by index so invoice replacements are tracked as image changes.
          for (let i = 0; i < nextInvoiceUrls.length; i++) {
            const prevEntry = previousInvoiceUrls[i];
            const nextEntry = nextInvoiceUrls[i];

            if (prevEntry.url !== nextEntry.url) {
              changes.push({
                changeType: 'invoiceImage',
                previousValue: JSON.stringify({ url: prevEntry.url }),
                newValue: JSON.stringify({ url: nextEntry.url }),
              });
            }

            if (prevEntry.invoiceStatus !== nextEntry.invoiceStatus || prevEntry.rejectionReason !== nextEntry.rejectionReason) {
              changes.push({
                changeType: 'invoiceStatus',
                previousValue: JSON.stringify({ url: nextEntry.url, invoiceStatus: prevEntry.invoiceStatus, rejectionReason: prevEntry.rejectionReason }),
                newValue: JSON.stringify({ url: nextEntry.url, invoiceStatus: nextEntry.invoiceStatus, rejectionReason: nextEntry.rejectionReason }),
              });
              // Track transition to 'confirmed' — only whileCreating
              // invoices trigger an execution date recompute.
              if (nextEntry.invoiceStatus === 'confirmed' && prevEntry.invoiceStatus !== 'confirmed') {
                if (nextEntry.whileCreating) {
                  firstInvoiceNewlyConfirmed = true;
                }
                // Transition payment to 'paid'
                await confirmInvoicePayment(nextEntry);
              }
              // Track transition to 'rejected' → set payment to 'failed'
              if (nextEntry.invoiceStatus === 'rejected' && prevEntry.invoiceStatus !== 'rejected') {
                setInvoicePaymentStatus(nextEntry, 'failed');
              }
              // Track transition to 'deleted' → set payment to 'failed'
              if (nextEntry.invoiceStatus === 'deleted' && prevEntry.invoiceStatus !== 'deleted') {
                setInvoicePaymentStatus(nextEntry, 'failed');
              }
              // Track transition FROM 'confirmed'/'rejected' back to 'waiting'/'pending'
              if (prevEntry.invoiceStatus !== 'waiting' && prevEntry.invoiceStatus !== 'pending' &&
                (nextEntry.invoiceStatus === 'waiting' || nextEntry.invoiceStatus === 'pending')) {
                setInvoicePaymentStatus(nextEntry, 'pending');
              }
            }

            if (prevEntry.value !== nextEntry.value || prevEntry.currency !== nextEntry.currency) {
              changes.push({
                changeType: 'invoiceValue',
                previousValue: JSON.stringify({ url: nextEntry.url, value: prevEntry.value, currency: prevEntry.currency }),
                newValue: JSON.stringify({ url: nextEntry.url, value: nextEntry.value, currency: nextEntry.currency }),
              });
              // Update the linked payment amounts for confirmed invoices
              await updateInvoicePaymentAmounts(nextEntry);
            }
          }
        } else {
          // Different lengths: match by URL and log added/removed invoices.
          const previousByUrl = new Map(previousInvoiceUrls.map((entry: IInvoiceUrl) => [entry.url, entry]));
          const nextByUrl = new Map(nextInvoiceUrls.map((entry: IInvoiceUrl) => [entry.url, entry]));

          for (const nextEntry of nextInvoiceUrls) {
            const prevEntry = previousByUrl.get(nextEntry.url);
            if (prevEntry) {
              if (prevEntry.invoiceStatus !== nextEntry.invoiceStatus || prevEntry.rejectionReason !== nextEntry.rejectionReason) {
                changes.push({
                  changeType: 'invoiceStatus',
                  previousValue: JSON.stringify({ url: nextEntry.url, invoiceStatus: prevEntry.invoiceStatus, rejectionReason: prevEntry.rejectionReason }),
                  newValue: JSON.stringify({ url: nextEntry.url, invoiceStatus: nextEntry.invoiceStatus, rejectionReason: nextEntry.rejectionReason }),
                });
                // Track transition to 'confirmed' — only whileCreating
                // invoices trigger an execution date recompute.
                if (nextEntry.invoiceStatus === 'confirmed' && prevEntry.invoiceStatus !== 'confirmed') {
                  if (nextEntry.whileCreating) {
                    firstInvoiceNewlyConfirmed = true;
                  }
                  // Transition payment to 'paid'
                  await confirmInvoicePayment(nextEntry);
                }
                // Track transition to 'rejected' → set payment to 'failed'
                if (nextEntry.invoiceStatus === 'rejected' && prevEntry.invoiceStatus !== 'rejected') {
                  setInvoicePaymentStatus(nextEntry, 'failed');
                }
                // Track transition to 'deleted' → set payment to 'failed'
                if (nextEntry.invoiceStatus === 'deleted' && prevEntry.invoiceStatus !== 'deleted') {
                  setInvoicePaymentStatus(nextEntry, 'failed');
                }
                // Track transition FROM 'confirmed'/'rejected' back to 'waiting'/'pending'
                if (prevEntry.invoiceStatus !== 'waiting' && prevEntry.invoiceStatus !== 'pending' &&
                  (nextEntry.invoiceStatus === 'waiting' || nextEntry.invoiceStatus === 'pending')) {
                  setInvoicePaymentStatus(nextEntry, 'pending');
                }
              }

              if (prevEntry.value !== nextEntry.value || prevEntry.currency !== nextEntry.currency) {
                changes.push({
                  changeType: 'invoiceValue',
                  previousValue: JSON.stringify({ url: nextEntry.url, value: prevEntry.value, currency: prevEntry.currency }),
                  newValue: JSON.stringify({ url: nextEntry.url, value: nextEntry.value, currency: nextEntry.currency }),
                });
                // Update the linked payment amounts for confirmed invoices
                await updateInvoicePaymentAmounts(nextEntry);
              }
            }
          }

          for (const nextEntry of nextInvoiceUrls) {
            if (!previousByUrl.has(nextEntry.url)) {
              changes.push({
                changeType: 'invoice',
                previousValue: null,
                newValue: JSON.stringify(nextEntry),
              });
            }
          }

          for (const prevEntry of previousInvoiceUrls) {
            if (!nextByUrl.has(prevEntry.url)) {
              changes.push({
                changeType: 'invoice',
                previousValue: JSON.stringify(prevEntry),
                newValue: null,
              });
              // Set the removed invoice's payment to 'failed' so it stays
              // visible in the payment timeline but is excluded from totals.
              setInvoicePaymentStatus(prevEntry, 'failed');
            }
          }
        }
      }
    }

    // NOTE: The total paid amount is allowed to exceed the order's
    // fullAmount — invoices may include fees, taxes, or tips that make
    // the paid amount larger than the order total. The order is simply
    // marked as "paid" when totalPaid >= fullAmount.

    if (changes.length === 0) {
      return NextResponse.json({
        success: true,
        data: sanitizeOrderForAdmin(order.toObject() as unknown as Record<string, unknown>),
        changed: false,
      });
    }

    // ── Auto-update order status from invoices/payments ────────────
    // When invoices are added or payments are recorded, recalculate the
    // order's financials and update the status if the paid amount covers
    // the full order (or part of it).
    // NOTE: paidAmount and remainingAmount are set by the pre('save')
    // hook via calculateOrderFinancials(), so we only handle the status
    // transition here.
    const FINANCIAL_CHANGE_TYPES = new Set(['invoice', 'invoiceStatus', 'invoiceValue', 'invoiceImage', 'payment', 'items', 'totalAmount']);
    const hasFinancialChange = changes.some((c) => FINANCIAL_CHANGE_TYPES.has(c.changeType));
    if (hasFinancialChange) {
      const { totalPaid, fullAmount } = calculateOrderFinancials(order);

      // Look up the payment-method tolerance from Booking settings.
      // The tolerance is configured per payment method (e.g. insta_pay
      // might have 50% tolerance, bank_transfer might have none).
      let orderAllowRate: { type: 'percentage' | 'fixnumber'; value: number } | null = null;
      let tolerancePaymentMethod: string | null = null;
      try {
        const bookingSettings = await Booking.findOne({ key: 'global' }).lean();
        const tolerances = bookingSettings?.paymentMethodTolerances;
        if (tolerances && typeof tolerances === 'object') {
          // Find the last invoice payment to get its payment method
          const lastInvoicePayment = Array.isArray(order.payments)
            ? order.payments
              .filter((p: IPayment) => p.paymentId?.startsWith('manual_invoice_'))
              .pop()
            : null;
          const pm = lastInvoicePayment?.paymentMethod;
          if (pm) {
            tolerancePaymentMethod = pm;
            const tolerance = (tolerances as Record<string, { type: 'percentage' | 'fixnumber'; value: number }>)[pm];
            if (tolerance && typeof tolerance.value === 'number' && tolerance.value > 0) {
              orderAllowRate = tolerance;
            }
          }
        }
      } catch {
        // Non-fatal — fall back to exact match
      }

      // Determine if the order is fully paid:
      // 1. Exact match: totalPaid >= fullAmount
      // 2. AllowRate: the last invoice value covers the remaining (before
      //    that invoice) within the country's tolerance
      const exactPaid = totalPaid >= fullAmount;
      const allowRateApplies =
        !exactPaid &&
        allowRateInvoiceValue !== null &&
        allowRateRemainingBefore !== null &&
        isInvoiceWithinAllowRate(allowRateInvoiceValue, allowRateRemainingBefore, orderAllowRate);

      if (fullAmount > 0) {
        const previousStatus = order.status;
        if (exactPaid || allowRateApplies) {
          // When tolerance applies, adjust the last payment's orderAmount
          // to cover the full remaining so that calculateOrderFinancials
          // returns remaining = 0. The actual invoice value (amount) is
          // preserved — only the accounting orderAmount is adjusted.
          if (allowRateApplies && !exactPaid && allowRateRemainingBefore !== null && allowRateInvoiceValue !== null && orderAllowRate) {
            const difference = Math.max(0, allowRateRemainingBefore - allowRateInvoiceValue);
            if (Array.isArray(order.payments)) {
              const lastInvoicePayment = order.payments
                .filter((p: IPayment) => p.paymentId?.startsWith('manual_invoice_'))
                .pop();
              if (lastInvoicePayment) {
                // Adjust orderAmount to cover the full remaining
                lastInvoicePayment.orderAmount = allowRateRemainingBefore;
                // Record the tolerance details for audit
                lastInvoicePayment.allowRateApplied = {
                  type: orderAllowRate.type,
                  value: orderAllowRate.value,
                  invoiceValue: allowRateInvoiceValue,
                  remainingBefore: allowRateRemainingBefore,
                  difference,
                  paymentMethod: tolerancePaymentMethod || undefined,
                };
                order.markModified('payments');
              }
            }
          }

          // Paid amount covers the full order (within allowRate tolerance)
          // → mark as paid
          order.isPartialPayment = false;
          if (order.status === 'partial-paid' || order.status === 'pending') {
            order.status = 'paid';
          }
        } else if (totalPaid > 0) {
          // Paid amount covers part of the order → mark as partial-paid.
          // This also handles the case where a previously "paid" order
          // drops back to partial-paid (e.g. an invoice was un-confirmed
          // and its payment was removed).
          order.isPartialPayment = true;
          if (order.status === 'pending' || order.status === 'paid') {
            order.status = 'partial-paid';
          }
        } else {
          // No paid amount at all → revert to pending
          order.isPartialPayment = false;
          if (order.status === 'paid' || order.status === 'partial-paid') {
            order.status = 'pending';
          }
        }

        if (order.status !== previousStatus) {
          changes.push({
            changeType: 'status',
            previousValue: previousStatus,
            newValue: order.status,
          });

          // Update whatsapp button state to match the new status
          const previousWhatsappState = order.isWhatsappButtonClicked;
          const nextWhatsappState = resolveWhatsappButtonState(
            order.status,
            previousStatus,
            previousWhatsappState,
          );
          if (nextWhatsappState !== previousWhatsappState) {
            order.isWhatsappButtonClicked = nextWhatsappState;
          }

          // Send confirmation email when status transitions to paid
          if (order.status === 'paid') {
            sendOrderConfirmationEmail(order.toObject() as IOrder).catch(() => { });
          }

          // Trigger auto design generation when status transitions to paid.
          // Also trigger if the order is paid but has no designs (e.g. a
          // previous auto-generation attempt failed silently).
          // Always logs the decision — even when skipped.
          evaluateAndTriggerAutoDesign(
            order.toObject(),
            previousStatus,
            'auto_admin',
          ).catch((err) => {
            console.error(
              `[admin PATCH] Auto design evaluation failed for order ${order.orderNumber}:`,
              err instanceof Error ? err.message : err,
            );
          });
        }
      }
    }

    // ── Recompute execution date when the first invoice is confirmed ──
    // Only the first invoice (whileCreating=true, uploaded during order
    // creation) triggers an execution date recompute. Later invoices
    // (whileCreating=false, added via PATCH) do NOT affect the date.
    // If the confirmation happens after the day's cutoff time, the order
    // cannot be processed on that day and must roll to the next.
    if (firstInvoiceNewlyConfirmed) {
      try {
        const booking = await Booking.findOne({ key: 'global' }).lean();
        if (booking) {
          const newDate = recomputeExecutionDateOnInvoiceConfirmed(
            { reservationData },
            booking,
          );
          if (newDate) {
            const reservation = reservationData.find((r) => r.key === 'executionDate');
            if (reservation) {
              const previousDate = reservation.value || null;
              reservation.value = newDate;
              changes.push({
                changeType: 'executionDate',
                previousValue: previousDate,
                newValue: newDate,
              });
              // Add an internal note documenting the date change
              if (!Array.isArray(order.internalNotes)) {
                order.internalNotes = [];
              }
              order.internalNotes.push({
                text: `Execution date changed from ${previousDate} to ${newDate} due to first invoice confirmation after day end.`,
                author: 'system',
                createdAt: new Date(),
              });
            }
          }
        }
      } catch (err) {
        console.error(
          `[admin PATCH] Failed to recompute execution date on invoice confirmation for ${order.orderNumber}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    order.reservationData = reservationData;
    await order.save();

    // Record change history entries. Wrap in try-catch so a history
    // failure (e.g. stale Mongoose model with old enum) doesn't roll
    // back the order save — the order is already persisted at this point.
    try {
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
    } catch (historyError) {
      console.error('Failed to record order change history (non-fatal):', historyError);
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

    // ── Auto design re-generation ────────────────────────────────────
    // When the admin edits names, duaa, items, or reservation data,
    // re-generate the design images in the background so they stay
    // in sync with the order data. Invoices and status-only edits do
    // not trigger this.
    const DESIGN_RELEVANT_CHANGE_TYPES = new Set(['name', 'duaa', 'photo', 'gender', 'isAlive', 'intention', 'items']);
    const shouldRegenerateDesigns = changes.some((c) => DESIGN_RELEVANT_CHANGE_TYPES.has(c.changeType));
    if (shouldRegenerateDesigns) {
      triggerDesignRegeneration(String(order._id), 'auto_admin').catch((err) => {
        console.error(`[PATCH /api/admin/orders/${order._id}] Design re-generation failed:`, err);
      });
    }

    return NextResponse.json({
      success: true,
      data: {
        ...sanitizeOrderForAdmin(order.toObject() as unknown as Record<string, unknown>),
        regeneratingDesigns: shouldRegenerateDesigns,
      },
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
