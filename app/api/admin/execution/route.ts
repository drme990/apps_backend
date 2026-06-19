import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import Order from '@/lib/models/Order';

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

    const matchStage: Record<string, unknown> = {};
    if (source && source !== 'all') {
      matchStage.source = source;
    }

    // Build aggregation that computes effective execution date per order:
    // - If reservationData contains executionDate, use its value
    // - Otherwise use createdAt + 1 day
    const pipeline: any[] = [
      { $match: matchStage },
      {
        $addFields: {
          executionDateEntry: {
            $arrayElemAt: [
              {
                $filter: {
                  input: { $ifNull: ['$reservationData', []] },
                  as: 'rd',
                  cond: { $eq: ['$$rd.key', 'executionDate'] },
                },
              },
              0,
            ],
          },
        },
      },
      {
        $addFields: {
          effectiveExecutionDate: {
            $cond: [
              { $ne: ['$executionDateEntry.value', null] },
              '$executionDateEntry.value',
              {
                $dateToString: {
                  format: '%Y-%m-%d',
                  date: { $add: ['$createdAt', 86400000] },
                },
              },
            ],
          },
        },
      },
      { $match: { effectiveExecutionDate: date } },
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
      const products = Array.from(productMap.values())
        .sort((a, b) => b.quantity - a.quantity);

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
