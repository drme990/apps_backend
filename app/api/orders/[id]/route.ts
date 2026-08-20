import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import Order, { type IInvoiceUrl } from '@/lib/models/Order';
import { logActivity } from '@/lib/services/logger';
import { calculateOrderFinancials } from '@/lib/services/order-financials';
import { z } from 'zod';
import mongoose from 'mongoose';

const allowedPatchFields = [
  'invoiceUrls',
  'payments',
  'paymentMethod',
  'sacrificeFor',
  'shortDuaa',
  'photo',
  'invoiceUrl',
  'invoiceStatus',
  'invoiceValue',
  'items',
  'gender',
  'isAlive',
  'intention',
  'status',
  'paidAmount',
  'remainingAmount',
];

const VALID_INVOICE_STATUSES = ['confirmed', 'waiting', 'pending', 'rejected'] as const;

function normalizeInvoiceUrls(
  invoiceUrls?: Array<{
    url: string;
    invoiceStatus?: string;
    rejectionReason?: string;
    value?: number;
    currency?: string;
  }>,
): IInvoiceUrl[] {
  return (invoiceUrls || []).map((invoice) => ({
    url: invoice.url,
    invoiceStatus:
      invoice.invoiceStatus && VALID_INVOICE_STATUSES.includes(invoice.invoiceStatus as (typeof VALID_INVOICE_STATUSES)[number])
        ? (invoice.invoiceStatus as (typeof VALID_INVOICE_STATUSES)[number])
        : 'waiting',
    rejectionReason: invoice.rejectionReason || '',
    value: typeof invoice.value === 'number' ? invoice.value : 0,
    currency: invoice.currency || 'EGP',
  }));
}

const putSchema = z.object({
  status: z.enum([
    'pending',
    'processing',
    'partial-paid',
    'paid',
    'completed',
    'failed',
    'refunded',
    'cancelled',
  ] as const),
  cancellationReason: z.string().optional(),
});

export async function GET(
  request: NextRequest,
  ctx: RouteContext<'/api/orders/[id]'>,
): Promise<NextResponse> {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess(['orders', 'invoices']);
    if ('error' in auth) return auth.error;

    const { id } = await ctx.params;
    if (!id || !mongoose.isValidObjectId(id)) {
      return NextResponse.json(
        { success: false, error: 'Invalid order id' },
        { status: 400 },
      );
    }

    const order = await Order.findById(id).lean();
    if (!order) {
      return NextResponse.json(
        { success: false, error: 'Order not found' },
        { status: 404 },
      );
    }

    const sanitized = {
      ...order,
      invoiceUrls: normalizeInvoiceUrls(order.invoiceUrls),
    };

    return NextResponse.json({ success: true, data: sanitized });
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
  ctx: RouteContext<'/api/orders/[id]'>,
): Promise<NextResponse> {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess(['orders', 'invoices']);
    if ('error' in auth) return auth.error;

    const { id } = await ctx.params;
    if (!id || !mongoose.isValidObjectId(id)) {
      return NextResponse.json(
        { success: false, error: 'Invalid order id' },
        { status: 400 },
      );
    }

    const body = await request.json().catch(() => ({}));
    const parsed = putSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: parsed.error.issues.map((e) => e.message).join(', ') },
        { status: 400 },
      );
    }

    const { status, cancellationReason } = parsed.data;

    const order = await Order.findById(id);
    if (!order) {
      return NextResponse.json(
        { success: false, error: 'Order not found' },
        { status: 404 },
      );
    }

    order.status = status;
    if (status === 'cancelled' && cancellationReason) {
      order.cancellationReason = cancellationReason;
    }

    await order.save();

    await logActivity({
      userId: auth.user.userId,
      userName: auth.user.name,
      userEmail: auth.user.email,
      action: 'update',
      resource: 'order',
      resourceId: order._id.toString(),
      details: `Updated order ${order.orderNumber} status to ${status}`,
    });

    const sanitized = {
      ...order.toObject(),
      invoiceUrls: normalizeInvoiceUrls(order.invoiceUrls),
    };

    return NextResponse.json({ success: true, data: sanitized });
  } catch (error) {
    console.error('Error updating order status:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to update order' },
      { status: 500 },
    );
  }
}

export async function PATCH(
  request: NextRequest,
  ctx: RouteContext<'/api/orders/[id]'>,
): Promise<NextResponse> {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess(['orders', 'invoices']);
    if ('error' in auth) return auth.error;

    const { id } = await ctx.params;
    if (!id || !mongoose.isValidObjectId(id)) {
      return NextResponse.json(
        { success: false, error: 'Invalid order id' },
        { status: 400 },
      );
    }

    const body = await request.json().catch(() => ({}));
    const fields: Record<string, unknown> = {};
    for (const key of allowedPatchFields) {
      if (key in body) {
        fields[key] = body[key];
      }
    }

    if (Object.keys(fields).length === 0) {
      return NextResponse.json(
        { success: false, error: 'No valid fields to update' },
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

    for (const [key, value] of Object.entries(fields)) {
      (order as unknown as Record<string, unknown>)[key] = value;
    }

    // Recalculate financials when payments are updated
    if ('payments' in fields) {
      const { totalPaid, remainingAmount } = calculateOrderFinancials(order);
      order.paidAmount = totalPaid;
      order.remainingAmount = remainingAmount;
    }

    // Auto-update order status when invoices change.
    // NOTE: paidAmount and remainingAmount are set by the pre('save')
    // hook via calculateOrderFinancials(), which now includes confirmed
    // invoice values. We only handle the status transition here.
    if ('invoiceUrl' in fields || 'invoiceUrls' in fields || 'invoiceValue' in fields || 'invoiceStatus' in fields) {
      const { totalPaid, fullAmount } = calculateOrderFinancials(order);

      if (totalPaid > 0 && fullAmount > 0) {
        if (totalPaid >= fullAmount) {
          order.isPartialPayment = false;
          if (order.status === 'partial-paid' || order.status === 'pending') {
            order.status = 'paid';
          }
        } else if (totalPaid < fullAmount) {
          order.isPartialPayment = true;
          if (order.status === 'pending') {
            order.status = 'partial-paid';
          }
        }
      }
    }

    await order.save();

    await logActivity({
      userId: auth.user.userId,
      userName: auth.user.name,
      userEmail: auth.user.email,
      action: 'update',
      resource: 'order',
      resourceId: order._id.toString(),
      details: `Updated order ${order.orderNumber} fields: ${Object.keys(fields).join(', ')}`,
    });

    const sanitized = {
      ...order.toObject(),
      invoiceUrls: normalizeInvoiceUrls(order.invoiceUrls),
    };

    return NextResponse.json({ success: true, data: sanitized });
  } catch (error) {
    console.error('Error patching order:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to update order' },
      { status: 500 },
    );
  }
}
