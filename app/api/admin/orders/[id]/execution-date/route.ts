import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import Order from '@/lib/models/Order';
import { logActivity } from '@/lib/services/logger';

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess('orders');
    if ('error' in auth) return auth.error;

    const { id } = await params;
    const body = await request.json().catch(() => ({}));
    const executionDate =
      body && typeof body.executionDate === 'string'
        ? body.executionDate.trim()
        : '';

    if (!executionDate) {
      return NextResponse.json(
        { success: false, error: 'Execution date is required' },
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

    const reservationData = Array.isArray(order.reservationData)
      ? order.reservationData
      : [];
    const idx = reservationData.findIndex(
      (f: { key?: string }) => f.key === 'executionDate',
    );
    if (idx >= 0) {
      reservationData[idx].value = executionDate;
    } else {
      reservationData.push({
        key: 'executionDate',
        label: { ar: 'تاريخ التنفيذ', en: 'Execution Date' },
        value: executionDate,
        type: 'date',
      });
    }
    order.reservationData = reservationData;
    await order.save();

    await logActivity({
      userId: auth.user.userId,
      userName: auth.user.name,
      userEmail: auth.user.email,
      action: 'update',
      resource: 'order',
      resourceId: order._id.toString(),
      details: `Updated execution date for order ${order.orderNumber} → ${executionDate}`,
    });

    return NextResponse.json({
      success: true,
      data: order.toObject(),
    });
  } catch (error) {
    console.error('Error updating execution date:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to update execution date' },
      { status: 500 },
    );
  }
}
