import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import Order from '@/lib/models/Order';
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
  'invoiceReviewed',
  'invoiceStatus',
  'invoiceValue',
  'items',
  'gender',
  'isAlive',
  'intention',
];

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
  { params }: { params: { id: string } },
) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess(['orders', 'invoices']);
    if ('error' in auth) return auth.error;

    const { id } = params;
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

    return NextResponse.json({ success: true, data: order });
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
  { params }: { params: { id: string } },
) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess(['orders', 'invoices']);
    if ('error' in auth) return auth.error;

    const { id } = params;
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

    return NextResponse.json({ success: true, data: order });
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
  { params }: { params: { id: string } },
) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess(['orders', 'invoices']);
    if ('error' in auth) return auth.error;

    const { id } = params;
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

    return NextResponse.json({ success: true, data: order });
  } catch (error) {
    console.error('Error patching order:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to update order' },
      { status: 500 },
    );
  }
}
