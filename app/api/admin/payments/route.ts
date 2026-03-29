import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import Order from '@/lib/models/Order';

function parseMonth(month: string | null): {
  start: Date;
  end: Date;
  key: string;
} {
  const now = new Date();
  const fallbackKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const key = month && /^\d{4}-\d{2}$/.test(month) ? month : fallbackKey;
  const [year, mon] = key.split('-').map(Number);
  const start = new Date(year, mon - 1, 1, 0, 0, 0, 0);
  const end = new Date(year, mon, 1, 0, 0, 0, 0);
  return { start, end, key };
}

export async function GET(request: NextRequest) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess('payments');
    if ('error' in auth) return auth.error;

    const { searchParams } = request.nextUrl;
    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10));
    const limit = Math.min(
      100,
      Math.max(10, parseInt(searchParams.get('limit') || '20', 10)),
    );
    const status = (searchParams.get('status') || '').trim();
    const source = (searchParams.get('source') || '').trim();
    const search = (searchParams.get('search') || '').trim();
    const { start, end, key } = parseMonth(searchParams.get('month'));
    const skip = (page - 1) * limit;

    const baseQuery: Record<string, unknown> = {
      createdAt: { $gte: start, $lt: end },
    };
    if (status && status !== 'all') baseQuery.status = status;
    if (source && source !== 'all') baseQuery.source = source;

    const query: Record<string, unknown> = {
      ...baseQuery,
      remainingAmount: { $gt: 0 },
    };
    if (search) {
      query.$or = [
        { orderNumber: { $regex: search, $options: 'i' } },
        { 'billingData.fullName': { $regex: search, $options: 'i' } },
        { 'billingData.email': { $regex: search, $options: 'i' } },
        { 'billingData.phone': { $regex: search, $options: 'i' } },
      ];
    }

    const paidCompletedQuery: Record<string, unknown> = {
      ...baseQuery,
      status: { $in: ['partially-paid', 'paid', 'completed'] },
    };

    const [orders, total, analyticsRows, paidCount] = await Promise.all([
      Order.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Order.countDocuments(query),
      Order.aggregate([
        { $match: paidCompletedQuery },
        {
          $group: {
            _id: null,
            totalEarned: {
              $sum: { $ifNull: ['$paidAmount', '$totalAmount'] },
            },
            totalCollected: { $sum: { $ifNull: ['$totalAmount', 0] } },
            totalDiscount: { $sum: { $ifNull: ['$couponDiscount', 0] } },
            ordersCount: { $sum: 1 },
          },
        },
      ]),
      Order.countDocuments(paidCompletedQuery),
    ]);

    const remainingRows = await Order.aggregate([
      { $match: { ...baseQuery, remainingAmount: { $gt: 0 } } },
      {
        $group: {
          _id: null,
          totalRemaining: { $sum: { $ifNull: ['$remainingAmount', 0] } },
        },
      },
    ]);

    const remainingSummary = remainingRows[0] || { totalRemaining: 0 };

    const analytics = analyticsRows[0] || {
      totalCollected: 0,
      totalEarned: 0,
      totalDiscount: 0,
      ordersCount: 0,
    };

    const totalPages = Math.max(1, Math.ceil(total / limit));

    return NextResponse.json({
      success: true,
      data: {
        month: key,
        analytics: {
          totalCollected: analytics.totalCollected || 0,
          totalPaid: analytics.totalEarned || 0,
          totalRemaining: remainingSummary.totalRemaining || 0,
          totalDiscount: analytics.totalDiscount || 0,
          ordersCount: analytics.ordersCount || 0,
          paidOrdersCount: paidCount,
        },
        orders,
        pagination: {
          currentPage: page,
          totalPages,
          totalOrders: total,
          hasNextPage: page < totalPages,
          hasPrevPage: page > 1,
        },
      },
    });
  } catch (error) {
    console.error('Error fetching payments:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch payments' },
      { status: 500 },
    );
  }
}
