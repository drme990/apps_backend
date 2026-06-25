import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import Order from '@/lib/models/Order';
import OrderChangeHistory from '@/lib/models/OrderChangeHistory';
import { logActivity } from '@/lib/services/logger';

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

    const result = await Order.updateMany(
      { _id: { $in: validIds } },
      [
        {
          $set: {
            reservationData: {
              $cond: {
                if: {
                  $anyElementTrue: {
                    $map: {
                      input: { $ifNull: ['$reservationData', []] },
                      as: 'f',
                      in: { $eq: ['$$f.key', 'executionDate'] },
                    },
                  },
                },
                then: {
                  $map: {
                    input: '$reservationData',
                    as: 'f',
                    in: {
                      $cond: {
                        if: { $eq: ['$$f.key', 'executionDate'] },
                        then: {
                          $mergeObjects: [
                            '$$f',
                            { value: executionDate },
                          ],
                        },
                        else: '$$f',
                      },
                    },
                  },
                },
                else: {
                  $concatArrays: [
                    { $ifNull: ['$reservationData', []] },
                    [
                      {
                        key: 'executionDate',
                        label: { ar: 'تاريخ التنفيذ', en: 'Execution Date' },
                        value: executionDate,
                        type: 'date',
                      },
                    ],
                  ],
                },
              },
            },
          },
        },
      ],
      { updatePipeline: true },
    );

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
      details: `Bulk updated execution date for ${result.modifiedCount} orders → ${executionDate}`,
    });

    return NextResponse.json({
      success: true,
      data: {
        updatedCount: result.modifiedCount,
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
