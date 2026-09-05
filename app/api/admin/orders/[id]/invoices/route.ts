import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import Order, {
  type IInvoiceUrl,
} from '@/lib/models/Order';
import OrderChangeHistory from '@/lib/models/OrderChangeHistory';
import { parseJsonBody } from '@/lib/validation/http';
import { z } from 'zod';

export const maxDuration = 60;

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
