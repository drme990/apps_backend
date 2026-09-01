import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import Order from '@/lib/models/Order';
import OrderChangeHistory from '@/lib/models/OrderChangeHistory';
import { logActivity } from '@/lib/services/logger';
import { triggerDesignRegeneration } from '@/lib/services/auto-design-generation';
import { renumberExecutionDay } from '@/lib/services/execution-number';

export async function PUT(request: NextRequest) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess('orders');
    if ('error' in auth) return auth.error;

    const body = await request.json().catch(() => ({}));
    const orderIds = Array.isArray(body.orderIds) ? body.orderIds : [];
    const executionDate =
      body && typeof body.executionDate === 'string'
        ? body.executionDate.trim()
        : '';

    if (!orderIds.length || !executionDate) {
      return NextResponse.json(
        { success: false, error: 'orderIds and executionDate are required' },
        { status: 400 },
      );
    }

    const validIds = orderIds
      .filter((id: unknown) => typeof id === 'string' && id.trim().length > 0)
      .map((id: string) => id.trim()) as string[];

    if (validIds.length === 0) {
      return NextResponse.json(
        { success: false, error: 'No valid order IDs provided' },
        { status: 400 },
      );
    }

    // Fetch existing execution dates for history tracking
    const existingOrders = await Order.find(
      { _id: { $in: validIds } },
      { reservationData: 1, source: 1, orderNumber: 1 },
    ).lean();

    const oldDates = new Map<string, string | null>();
    for (const o of existingOrders) {
      const dateField = (o.reservationData as Array<{ key: string; value: string }> | undefined)?.find(
        (f) => f.key === 'executionDate',
      );
      oldDates.set(String(o._id), dateField?.value || null);
    }

    // Load and save each order so the pre-save hook can re-assign the
    // execution number (per-date, atomic counter) and fire other hooks.
    const CONCURRENCY = 10;
    let updatedCount = 0;
    for (let i = 0; i < validIds.length; i += CONCURRENCY) {
      const chunk = validIds.slice(i, i + CONCURRENCY);
      await Promise.all(
        chunk.map(async (id) => {
          const order = await Order.findById(id);
          if (!order) return;

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

          // Trigger pre-save hook (recomputes execution number if needed)
          await order.save();
          updatedCount += 1;
        }),
      );
    }

    // Renumber the target execution date so all orders on it (including
    // the newly moved ones) form a clean 1..N sequence. Also renumber
    // any old dates that orders moved from (the post-save hook handles
    // this per-order, but we do it once more here to be safe with
    // concurrent saves).
    const oldDatesToRenumber = new Set<string>();
    for (const oldDate of oldDates.values()) {
      if (oldDate && oldDate !== executionDate) {
        oldDatesToRenumber.add(oldDate);
      }
    }
    for (const date of oldDatesToRenumber) {
      await renumberExecutionDay(date);
    }
    await renumberExecutionDay(executionDate);

    // Create order change history for each modified order
    const historyEntries = [];
    for (const order of existingOrders) {
      const oldDate = oldDates.get(String(order._id));
      if (oldDate !== executionDate) {
        historyEntries.push({
          orderId: String(order._id),
          appId: (order.source as 'manasik' | 'ghadaq') || 'ghadaq',
          changeType: 'bulk_execution_date' as const,
          previousValue: oldDate,
          newValue: executionDate,
          changedByUserId: auth.user.userId,
          changedByUserName: auth.user.name,
          changedByUserEmail: auth.user.email,
        });
      }
    }
    if (historyEntries.length > 0) {
      await OrderChangeHistory.insertMany(historyEntries);
    }

    await logActivity({
      userId: auth.user.userId,
      userName: auth.user.name,
      userEmail: auth.user.email,
      action: 'update',
      resource: 'order',
      resourceId: validIds.map((id) => id.toString()).join(', '),
      details: `Bulk updated execution date for ${updatedCount} orders → ${executionDate}`,
    });

    // ── Auto design re-generation ────────────────────────────────────
    // The execution date appears on the design as a dynamic field
    // ("تاريخ التنفيذ"). When it changes in bulk, re-generate the design
    // images for each affected order so they stay in sync. Fire-and-forget
    // — the response returns immediately; each regeneration runs in the
    // background via the backend's design queue (serialized by the
    // concurrency slot, so bursts don't overwhelm the design app).
    for (const order of existingOrders) {
      const oldDate = oldDates.get(String(order._id));
      if (oldDate !== executionDate) {
        triggerDesignRegeneration(String(order._id), 'auto_admin').catch(() => {
          // Best-effort — the design will be synced on the next window focus
        });
      }
    }

    return NextResponse.json({
      success: true,
      data: {
        updatedCount,
        regeneratingDesigns: updatedCount,
      },
    });
  } catch (error) {
    console.error('Error bulk updating execution dates:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to bulk update execution dates' },
      { status: 500 },
    );
  }
}
