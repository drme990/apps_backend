import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import Order from '@/lib/models/Order';
import OrderChangeHistory from '@/lib/models/OrderChangeHistory';
import { logActivity } from '@/lib/services/logger';
import { triggerDesignRegeneration } from '@/lib/services/auto-design-generation';

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
    const oldExecutionDate = (reservationData as Array<{ key?: string; value: string }>).find(
      (f) => f.key === 'executionDate',
    )?.value || null;

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

    // Track execution date change in history
    if (oldExecutionDate !== executionDate) {
      await OrderChangeHistory.create({
        orderId: String(order._id),
        appId: (order.source as 'manasik' | 'ghadaq') || 'ghadaq',
        changeType: 'executionDate',
        previousValue: oldExecutionDate,
        newValue: executionDate,
        changedByUserId: auth.user.userId,
        changedByUserName: auth.user.name,
        changedByUserEmail: auth.user.email,
      });
    }

    await logActivity({
      userId: auth.user.userId,
      userName: auth.user.name,
      userEmail: auth.user.email,
      action: 'update',
      resource: 'order',
      resourceId: order._id.toString(),
      details: `Updated execution date for order ${order.orderNumber} → ${executionDate}`,
    });

    // ── Auto design re-generation ────────────────────────────────────
    // The execution date appears on the design as a dynamic field
    // ("تاريخ التنفيذ"). When it changes, re-generate the design images
    // so they stay in sync with the new date. Fire-and-forget — the
    // response returns immediately; the regeneration runs in the
    // background via the backend's design queue.
    if (oldExecutionDate !== executionDate) {
      triggerDesignRegeneration(String(order._id), 'auto_admin').catch(() => {
        // Best-effort — the design will be synced on the next window focus
      });
    }

    return NextResponse.json({
      success: true,
      data: order.toObject(),
      regeneratingDesigns: oldExecutionDate !== executionDate,
    });
  } catch (error) {
    console.error('Error updating execution date:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to update execution date' },
      { status: 500 },
    );
  }
}
