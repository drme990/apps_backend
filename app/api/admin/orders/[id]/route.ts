import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import Order, { type IOrder, type IInvoiceUrl, type IPayment, type OrderStatus } from '@/lib/models/Order';
import OrderChangeHistory, { type IOrderChangeHistory } from '@/lib/models/OrderChangeHistory';
import { resolveWhatsappButtonState } from '@/lib/services/whatsapp-button-state';
import { logActivity } from '@/lib/services/logger';
import { sendOrderConfirmationEmail } from '@/lib/services/email';
import {
  shouldTriggerAutoDesignGeneration,
  triggerAutoDesignGeneration,
  triggerDesignRegeneration,
} from '@/lib/services/auto-design-generation';
import { parseJsonBody } from '@/lib/validation/http';
import { orderStatusUpdateSchema } from '@/lib/validation/schemas';
import { calculateOrderFinancials } from '@/lib/services/order-financials';
import Booking from '@/lib/models/Booking';
import { recomputeExecutionDateOnInvoiceConfirmed } from '@/lib/execution-date';

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
  }>,
): Array<{
  url: string;
  invoiceStatus: 'confirmed' | 'waiting' | 'pending' | 'rejected';
  rejectionReason: string;
  value: number;
  currency: string;
}> {
  const VALID_STATUSES = ['confirmed', 'waiting', 'pending', 'rejected'] as const;
  return (invoiceUrls || []).map((invoice: {
    url: string;
    invoiceStatus?: string;
    rejectionReason?: string;
    value?: number;
    currency?: string;
  }) => {
    const invoiceStatus: 'confirmed' | 'waiting' | 'pending' | 'rejected' =
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
    // Triggered when the admin manually changes the order status to
    // 'paid' or 'partial-paid' from a non-paid state. Fire-and-forget.
    if (shouldTriggerAutoDesignGeneration(previousStatus, nextStatus)) {
      triggerAutoDesignGeneration(String(order._id), 'auto_admin').catch((err) => {
        console.error(
          `[admin PUT] Auto design generation failed for order ${order.orderNumber}:`,
          err instanceof Error ? err.message : err,
        );
      });
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
    // Track whether any invoice was newly confirmed during this PATCH —
    // used to recompute the execution date if the day has ended.
    let invoiceNewlyConfirmed = false;

    // ── Helpers to add/remove payment entries linked to invoices ──
    // Payments are only recorded for confirmed invoices. When an invoice
    // is confirmed, a payment entry is added. When it's un-confirmed, the
    // matching payment is removed so the order's paid amount reverts.
    const invoicePaymentId = (url: string) => `manual_invoice_${url.slice(-50)}`;

    const addInvoicePayment = (invoice: IInvoiceUrl, paymentMethodOverride?: IPayment['paymentMethod']) => {
      if (invoice.value <= 0) return;
      if (!Array.isArray(order.payments)) order.payments = [];
      const pid = invoicePaymentId(invoice.url);
      // Don't add duplicate
      if (order.payments.some((p: IPayment) => p.paymentId === pid)) return;
      const currency = (invoice.currency || order.currency || 'EGP').toUpperCase();
      const pm = paymentMethodOverride || (order.paymentMethod || 'bank_transfer') as IPayment['paymentMethod'];
      order.payments.push({
        paymentId: pid,
        easykashOrderId: `manual-invoice-${invoice.url.slice(-50)}`,
        orderAmount: invoice.value,
        gatewayAmount: invoice.value,
        gatewayCurrency: currency,
        amount: invoice.value,
        currency,
        status: 'paid',
        paymentMethod: pm,
        createdAt: new Date(),
        paidAt: new Date(),
      });
      changes.push({
        changeType: 'payment',
        previousValue: null,
        newValue: JSON.stringify({ paidAmount: invoice.value, invoiceUrl: invoice.url, currency, paymentMethod: pm }),
      });
    };

    const removeInvoicePayment = (invoice: IInvoiceUrl) => {
      if (!Array.isArray(order.payments)) return;
      const pid = invoicePaymentId(invoice.url);
      const idx = order.payments.findIndex((p: IPayment) => p.paymentId === pid);
      if (idx >= 0) {
        const removed = order.payments[idx];
        order.payments.splice(idx, 1);
        changes.push({
          changeType: 'payment',
          previousValue: JSON.stringify({ paidAmount: removed.amount, invoiceUrl: invoice.url, currency: removed.currency }),
          newValue: null,
        });
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
      const value = typeof body.invoiceValue === 'number' ? body.invoiceValue : 0;
      const VALID_STATUSES = ['confirmed', 'waiting', 'pending', 'rejected'] as const;
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

        // Track if this new invoice is confirmed — used to recompute
        // the execution date if the day has ended.
        if (invoiceStatus === 'confirmed') {
          invoiceNewlyConfirmed = true;
        }

        // ── Only record a payment entry when the invoice is confirmed.
        //    If the invoice is waiting/pending/rejected, the paid amount
        //    is NOT added to the order — it will be added later when the
        //    invoice status changes to "confirmed". ──
        if (invoiceStatus === 'confirmed') {
          addInvoicePayment(newEntry, paymentMethod);
        }
      }
    }

    if (Array.isArray(body.invoiceUrls)) {
      const VALID_STATUSES = ['confirmed', 'waiting', 'pending', 'rejected'] as const;
      const nextInvoiceUrls: IInvoiceUrl[] = body.invoiceUrls
        .filter((entry: unknown) => entry && typeof (entry as { url?: string }).url === 'string')
        .map((entry: unknown) => {
          const rawStatus = (entry as { invoiceStatus?: unknown }).invoiceStatus;
          const invoiceStatus =
            typeof rawStatus === 'string' && VALID_STATUSES.includes(rawStatus as (typeof VALID_STATUSES)[number])
              ? (rawStatus as (typeof VALID_STATUSES)[number])
              : 'waiting';
          return {
            url: (entry as { url: string }).url.trim(),
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
              // Track transition to 'confirmed'
              if (nextEntry.invoiceStatus === 'confirmed' && prevEntry.invoiceStatus !== 'confirmed') {
                invoiceNewlyConfirmed = true;
                // Add payment for newly confirmed invoice
                addInvoicePayment(nextEntry);
              }
              // Track transition FROM 'confirmed' to non-confirmed
              if (prevEntry.invoiceStatus === 'confirmed' && nextEntry.invoiceStatus !== 'confirmed') {
                // Remove the payment linked to this invoice
                removeInvoicePayment(prevEntry);
              }
            }

            if (prevEntry.value !== nextEntry.value || prevEntry.currency !== nextEntry.currency) {
              changes.push({
                changeType: 'invoiceValue',
                previousValue: JSON.stringify({ url: nextEntry.url, value: prevEntry.value, currency: prevEntry.currency }),
                newValue: JSON.stringify({ url: nextEntry.url, value: nextEntry.value, currency: nextEntry.currency }),
              });
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
                // Track transition to 'confirmed'
                if (nextEntry.invoiceStatus === 'confirmed' && prevEntry.invoiceStatus !== 'confirmed') {
                  invoiceNewlyConfirmed = true;
                  // Add payment for newly confirmed invoice
                  addInvoicePayment(nextEntry);
                }
                // Track transition FROM 'confirmed' to non-confirmed
                if (prevEntry.invoiceStatus === 'confirmed' && nextEntry.invoiceStatus !== 'confirmed') {
                  // Remove the payment linked to this invoice
                  removeInvoicePayment(prevEntry);
                }
              }

              if (prevEntry.value !== nextEntry.value || prevEntry.currency !== nextEntry.currency) {
                changes.push({
                  changeType: 'invoiceValue',
                  previousValue: JSON.stringify({ url: nextEntry.url, value: prevEntry.value, currency: prevEntry.currency }),
                  newValue: JSON.stringify({ url: nextEntry.url, value: nextEntry.value, currency: nextEntry.currency }),
                });
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
              // If the removed invoice was confirmed, remove its payment too
              if (prevEntry.invoiceStatus === 'confirmed') {
                removeInvoicePayment(prevEntry);
              }
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
    const FINANCIAL_CHANGE_TYPES = new Set(['invoice', 'invoiceStatus', 'invoiceValue', 'invoiceImage', 'payment']);
    const hasFinancialChange = changes.some((c) => FINANCIAL_CHANGE_TYPES.has(c.changeType));
    if (hasFinancialChange) {
      const { totalPaid, fullAmount } = calculateOrderFinancials(order);

      if (fullAmount > 0) {
        const previousStatus = order.status;
        if (totalPaid >= fullAmount) {
          // Paid amount covers the full order → mark as paid
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

          // Trigger auto design generation when status transitions to paid
          if (shouldTriggerAutoDesignGeneration(previousStatus, order.status)) {
            triggerAutoDesignGeneration(String(order._id), 'auto_admin').catch((err) => {
              console.error(
                `[admin PATCH] Auto design generation failed for order ${order.orderNumber}:`,
                err instanceof Error ? err.message : err,
              );
            });
          }
        }
      }
    }

    // ── Recompute execution date when an invoice is newly confirmed ──
    // Only recompute if ALL invoices on the order are confirmed. If any
    // invoice is still waiting/pending/rejected, the order is not yet
    // ready for execution and the date should not change.
    // If the confirmation happens after the day's cutoff time, the order
    // cannot be processed on that day and must roll to the next.
    const allInvoicesConfirmed =
      invoiceNewlyConfirmed &&
      Array.isArray(order.invoiceUrls) &&
      order.invoiceUrls.length > 0 &&
      order.invoiceUrls.every((inv: IInvoiceUrl) => inv.invoiceStatus === 'confirmed');

    if (allInvoicesConfirmed) {
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
                text: `Execution date changed from ${previousDate} to ${newDate} due to invoice confirmation after day end.`,
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
