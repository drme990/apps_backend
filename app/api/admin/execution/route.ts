import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import Order from '@/lib/models/Order';

/**
 * Execution orders API
 *
 * Returns all orders whose effective execution date matches the requested date.
 * Effective execution date is determined by:
 * - reservationData.executionDate.value (first 10 chars extracted to handle ISO/datetime)
 * - OR createdAt + 1 day if no executionDate is specified
 *
 * Only includes orders with status: paid, partial-paid.
 */
export async function GET(request: NextRequest) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess('orders');
    if ('error' in auth) return auth.error;

    const { searchParams } = request.nextUrl;
    const date = searchParams.get('date');
    const source = searchParams.get('source');

    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return NextResponse.json(
        { success: false, error: 'Invalid date format. Expected YYYY-MM-DD.' },
        { status: 400 },
      );
    }

    // Only paid / partially paid orders should appear in execution
    const PAID_STATUSES = ['paid', 'partial-paid'];

    const matchStage: Record<string, unknown> = {
      status: { $in: PAID_STATUSES },
    };
    if (source && source !== 'all') {
      matchStage.source = source;
    }

    // Aggregation pipeline
    const pipeline: any[] = [
      // 1. Base filter: paid statuses + source
      { $match: matchStage },

      // 2. Safely extract executionDate.value from reservationData using $reduce.
      //    Returns the value string if found, otherwise '' (never null/undefined).
      {
        $addFields: {
          executionDateValue: {
            $ifNull: [
              {
                $reduce: {
                  input: { $ifNull: ['$reservationData', []] },
                  initialValue: '',
                  in: {
                    $cond: [
                      { $eq: ['$$this.key', 'executionDate'] },
                      '$$this.value',
                      '$$value',
                    ],
                  },
                },
              },
              '',
            ],
          },
        },
      },

      // 3. Compute effectiveExecutionDate
      //    - If executionDateValue is not empty, take first 10 chars
      //    - Otherwise default to createdAt + 1 day (UTC)
      {
        $addFields: {
          effectiveExecutionDate: {
            $cond: [
              { $eq: ['$executionDateValue', ''] },
              {
                $dateToString: {
                  format: '%Y-%m-%d',
                  date: { $add: ['$createdAt', 86400000] },
                  timezone: 'UTC',
                },
              },
              { $substr: ['$executionDateValue', 0, 10] },
            ],
          },
        },
      },

      // 4. Filter by the requested execution date
      { $match: { effectiveExecutionDate: date } },

      // 5. Project only needed fields
      {
        $project: {
          _id: 1,
          orderNumber: 1,
          userId: 1,
          isGuest: 1,
          items: 1,
          totalAmount: 1,
          currency: 1,
          status: 1,
          billingData: 1,
          source: 1,
          createdAt: 1,
          reservationData: 1,
          effectiveExecutionDate: 1,
        },
      },

      // 6. Sort newest first
      { $sort: { createdAt: -1 } },
    ];

    const orders = await Order.aggregate(pipeline);

    // Stats: total orders, total items, product breakdown
    const stats = {
      totalOrders: orders.length,
      totalItems: 0,
      byProduct: [] as Array<{
        productName: string;
        productNameAr: string;
        quantity: number;
        percentage: number;
      }>,
    };

    const productMap = new Map<
      string,
      { productName: string; productNameAr: string; quantity: number }
    >();

    for (const order of orders) {
      const items = Array.isArray(order.items) ? order.items : [];
      for (const item of items) {
        const qty = typeof item.quantity === 'number' ? item.quantity : 0;
        stats.totalItems += qty;

        const nameEn = item.productName?.en || 'Unknown';
        const nameAr = item.productName?.ar || nameEn;
        const key = nameEn;

        const existing = productMap.get(key);
        if (existing) {
          existing.quantity += qty;
        } else {
          productMap.set(key, {
            productName: nameEn,
            productNameAr: nameAr,
            quantity: qty,
          });
        }
      }
    }

    if (stats.totalItems > 0) {
      const products = Array.from(productMap.values()).sort(
        (a, b) => b.quantity - a.quantity,
      );

      stats.byProduct = products.map((p) => ({
        productName: p.productName,
        productNameAr: p.productNameAr,
        quantity: p.quantity,
        percentage: Math.round((p.quantity / stats.totalItems) * 1000) / 10,
      }));
    }

    return NextResponse.json({
      success: true,
      data: {
        orders,
        stats,
        date,
      },
    });
  } catch (error) {
    console.error('[Execution API] Error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to load execution data' },
      { status: 500 },
    );
  }
}
