import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import Order from '@/lib/models/Order';
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
    );

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
