import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import Order, {
  type IInvoiceUrl,
  type IDeletedInvoice,
} from '@/lib/models/Order';
import OrderChangeHistory from '@/lib/models/OrderChangeHistory';
import { calculateOrderFinancials } from '@/lib/services/order-financials';
import { parseJsonBody } from '@/lib/validation/http';
import { z } from 'zod';

export const maxDuration = 60;

const deleteInvoiceSchema = z
  .object({
    url: z.string().trim().min(1),
    reason: z.enum([
      'returned',
      'duplicate',
      'fake',
      'test',
      'uploaded_by_mistake',
      'other',
    ]),
    customReason: z.string().trim().optional().default(''),
  })
  .strict();

/**
 * DELETE /api/admin/orders/[id]/invoices
 *
 * Removes a single invoice from an order. The invoice file is deleted
 * from R2, the invoice entry is removed from `order.invoiceUrls`, and
 * an audit entry is added to `order.deletedInvoices` with the reason.
 *
 * If the invoice was `confirmed`, its linked `manual_invoice_*` payment
 * is also removed so the order's paid amount is correctly recalculated.
 *
 * Request body:
 *   { url: string, reason: InvoiceDeletionReason, customReason?: string }
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess(['orders', 'invoices']);
    if ('error' in auth) return auth.error;

    const { id } = await params;

    const parsed = await parseJsonBody(request, deleteInvoiceSchema);
    if (!parsed.success) return parsed.response;
    const { url, reason, customReason } = parsed.data;

    if (reason === 'other' && !customReason) {
      return NextResponse.json(
        {
          success: false,
          error: 'Custom reason is required when reason is "other"',
        },
        { status: 400 },
      );
    }

    const order = await Order.findById(id);
    if (!order) {
      return NextResponse.json(
        { success: false, error: 'Order not found' },
        { status: 404 },
      );
    }

    const invoices = Array.isArray(order.invoiceUrls) ? order.invoiceUrls : [];
    const invoiceIndex = invoices.findIndex(
      (inv: IInvoiceUrl) => inv.url === url,
    );
    if (invoiceIndex < 0) {
      return NextResponse.json(
        { success: false, error: 'Invoice not found on this order' },
        { status: 404 },
      );
    }

    const targetInvoice = invoices[invoiceIndex];

    // ── Soft-delete: mark the invoice as deleted instead of removing it ──
    // The invoice stays in the invoiceUrls array with deleted=true so it
    // can be restored if needed, but it's filtered out in API responses.
    targetInvoice.deleted = true;
    targetInvoice.deletedAt = new Date();

    // ── Update the linked payment status to 'failed' ──
    // Instead of removing the payment entry, set its status to 'failed'
    // so it remains visible in the payment timeline (with a failed badge)
    // but is excluded from paid-amount calculations by calculateOrderFinancials.
    if (
      !targetInvoice.whileCreating &&
      Array.isArray(order.payments)
    ) {
      const pid = `manual_invoice_${targetInvoice.url.slice(-50)}`;
      const payIdx = order.payments.findIndex(
        (p: { paymentId?: string }) => p.paymentId === pid,
      );
      if (payIdx >= 0) {
        order.payments[payIdx].status = 'failed';
      }
    }

    // ── Add audit entry to deletedInvoices ──
    if (!Array.isArray(order.deletedInvoices)) {
      order.deletedInvoices = [];
    }
    const deletedEntry: IDeletedInvoice = {
      url: targetInvoice.url,
      reason,
      customReason: reason === 'other' ? customReason : '',
      value: targetInvoice.value || 0,
      currency: targetInvoice.currency || order.currency || 'EGP',
      invoiceStatus: targetInvoice.invoiceStatus,
      deletedAt: new Date(),
      deletedBy: auth.user.userId?.toString(),
    };
    order.deletedInvoices.push(deletedEntry);

    // ── Recalculate order status from financials ──
    // The pre('save') hook recomputes paidAmount/remainingAmount via
    // calculateOrderFinancials(). Here we only handle the status transition.
    const { totalPaid, fullAmount } = calculateOrderFinancials(order);
    const previousStatus = order.status;
    if (fullAmount > 0 && totalPaid >= fullAmount) {
      order.status = 'paid';
    } else if (totalPaid > 0) {
      order.status = 'partial-paid';
    } else {
      order.status = 'pending';
    }

    await order.save();

    // ── R2 file is NOT deleted — this is a soft delete. ──
    // The invoice file is retained in R2 for audit/restore purposes.
    // It's simply hidden from normal views via the `deleted` flag.

    // ── Log the change to order history ──
    try {
      await OrderChangeHistory.create({
        orderId: String(order._id),
        appId: order.source || 'ghadaq',
        changeType: 'invoiceDeleted',
        previousValue: JSON.stringify({
          url: targetInvoice.url,
          value: targetInvoice.value,
          currency: targetInvoice.currency,
          invoiceStatus: targetInvoice.invoiceStatus,
        }),
        newValue: JSON.stringify({
          reason,
          customReason: reason === 'other' ? customReason : '',
        }),
        changedByUserId: auth.user.userId,
        changedByUserName: auth.user.name,
        changedByUserEmail: auth.user.email,
      });
      if (previousStatus !== order.status) {
        await OrderChangeHistory.create({
          orderId: String(order._id),
          appId: order.source || 'ghadaq',
          changeType: 'status',
          previousValue: previousStatus,
          newValue: order.status,
          changedByUserId: auth.user.userId,
          changedByUserName: auth.user.name,
          changedByUserEmail: auth.user.email,
        });
      }
    } catch (historyErr) {
      console.error('Failed to log invoice deletion to history:', historyErr);
    }

    // ── Return the sanitized updated order ──
    const sanitized = order.toObject();
    delete sanitized.easykashRef;
    delete sanitized.easykashProductCode;
    delete sanitized.easykashVoucher;
    delete sanitized.easykashResponse;

    return NextResponse.json({
      success: true,
      data: sanitized,
    });
  } catch (error) {
    console.error('Delete invoice error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to delete invoice' },
      { status: 500 },
    );
  }
}

// ── Schema for editing invoice value/currency ──
const editInvoiceSchema = z
  .object({
    url: z.string().trim().min(1),
    value: z.number().min(0),
    currency: z.string().trim().optional(),
  })
  .strict();

/**
 * PATCH /api/admin/orders/[id]/invoices
 *
 * Edits a single invoice's value and/or currency. The invoice is
 * identified by its `url` (which is unique within the order's
 * `invoiceUrls` array).
 *
 * If the invoice is `confirmed` and has a linked `manual_invoice_*`
 * payment, the payment's amounts are also updated to reflect the new
 * invoice value/currency, so the order's paid amount stays correct.
 *
 * Request body:
 *   { url: string, value: number, currency?: string }
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess(['orders', 'invoices']);
    if ('error' in auth) return auth.error;

    const { id } = await params;

    const parsed = await parseJsonBody(request, editInvoiceSchema);
    if (!parsed.success) return parsed.response;
    const { url, value, currency } = parsed.data;

    const order = await Order.findById(id);
    if (!order) {
      return NextResponse.json(
        { success: false, error: 'Order not found' },
        { status: 404 },
      );
    }

    const invoices = Array.isArray(order.invoiceUrls) ? order.invoiceUrls : [];
    const invoiceIndex = invoices.findIndex(
      (inv: IInvoiceUrl) => inv.url === url,
    );
    if (invoiceIndex < 0) {
      return NextResponse.json(
        { success: false, error: 'Invoice not found on this order' },
        { status: 404 },
      );
    }

    const invoice = invoices[invoiceIndex];
    const previousValue = invoice.value;
    const previousCurrency = invoice.currency;
    const newCurrency = (currency || invoice.currency || order.currency || 'EGP').toUpperCase();

    // Update the invoice entry
    invoice.value = value;
    invoice.currency = newCurrency;

    // ── Update the linked payment if the invoice is confirmed ──
    if (
      !invoice.whileCreating &&
      invoice.invoiceStatus === 'confirmed' &&
      Array.isArray(order.payments)
    ) {
      const pid = `manual_invoice_${invoice.url.slice(-50)}`;
      const payIdx = order.payments.findIndex(
        (p: { paymentId?: string }) => p.paymentId === pid,
      );
      if (payIdx >= 0) {
        const payment = order.payments[payIdx] as {
          amount: number;
          currency: string;
          orderAmount: number;
          gatewayAmount: number;
        };
        payment.amount = value;
        payment.currency = newCurrency;

        // Recalculate orderAmount if currency changed or value changed
        const orderCurrency = (order.currency || 'EGP').toUpperCase();
        if (newCurrency !== orderCurrency) {
          try {
            const { convertCurrency } = await import('@/lib/services/currency');
            payment.orderAmount = await convertCurrency(value, newCurrency, orderCurrency);
          } catch {
            payment.orderAmount = value;
          }
        } else {
          payment.orderAmount = value;
        }

        // Recalculate gatewayAmount
        const EASYKASH_SUPPORTED = new Set(['SAR', 'EGP', 'USD', 'EUR']);
        const gatewayCurrency = EASYKASH_SUPPORTED.has(orderCurrency)
          ? orderCurrency
          : 'EGP';
        if (orderCurrency !== gatewayCurrency) {
          try {
            const { convertCurrency } = await import('@/lib/services/currency');
            payment.gatewayAmount = await convertCurrency(
              payment.orderAmount,
              orderCurrency,
              gatewayCurrency,
            );
          } catch {
            payment.gatewayAmount = payment.orderAmount;
          }
        } else {
          payment.gatewayAmount = payment.orderAmount;
        }
      }
    }

    await order.save();

    // ── Log the change ──
    try {
      await OrderChangeHistory.create({
        orderId: String(order._id),
        appId: order.source || 'ghadaq',
        changeType: 'invoiceValue',
        previousValue: JSON.stringify({
          url: invoice.url,
          value: previousValue,
          currency: previousCurrency,
        }),
        newValue: JSON.stringify({
          url: invoice.url,
          value,
          currency: newCurrency,
        }),
        changedByUserId: auth.user.userId,
        changedByUserName: auth.user.name,
        changedByUserEmail: auth.user.email,
      });
    } catch (historyErr) {
      console.error('Failed to log invoice edit to history:', historyErr);
    }

    const sanitized = order.toObject();
    delete sanitized.easykashRef;
    delete sanitized.easykashProductCode;
    delete sanitized.easykashVoucher;
    delete sanitized.easykashResponse;

    return NextResponse.json({
      success: true,
      data: sanitized,
    });
  } catch (error) {
    console.error('Edit invoice error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to edit invoice' },
      { status: 500 },
    );
  }
}
