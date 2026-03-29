import { NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import Order from '@/lib/models/Order';

type RevenuePoint = { label: string; revenue: number };
type AnalyticsMatchFilter = { status?: string };

function getLastDaysRange(days: number): Date {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  now.setDate(now.getDate() - (days - 1));
  return now;
}

function getLastMonthsRange(months: number): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth() - (months - 1), 1);
}

function formatDayKey(date: Date): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function formatMonthKey(date: Date): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  return `${yyyy}-${mm}`;
}

function buildDaySeries(
  map: Map<string, number>,
  days: number,
): RevenuePoint[] {
  const points: RevenuePoint[] = [];
  const cursor = getLastDaysRange(days);

  for (let i = 0; i < days; i += 1) {
    const key = formatDayKey(cursor);
    points.push({ label: key, revenue: map.get(key) ?? 0 });
    cursor.setDate(cursor.getDate() + 1);
  }

  return points;
}

function buildMonthSeries(
  map: Map<string, number>,
  months: number,
): RevenuePoint[] {
  const points: RevenuePoint[] = [];
  const cursor = getLastMonthsRange(months);

  for (let i = 0; i < months; i += 1) {
    const key = formatMonthKey(cursor);
    points.push({ label: key, revenue: map.get(key) ?? 0 });
    cursor.setMonth(cursor.getMonth() + 1);
  }

  return points;
}

export async function GET(request: Request) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess('analytics');
    if ('error' in auth) return auth.error;

    const { searchParams } = new URL(request.url);
    const daysParam = searchParams.get('days');
    const monthsParam = searchParams.get('months');
    const statusParam = searchParams.get('status');

    const days = daysParam ? parseInt(daysParam, 10) : 30;
    const months = monthsParam ? parseInt(monthsParam, 10) : 12;

    const dayStart = getLastDaysRange(days);
    const monthStart = getLastMonthsRange(months);

    // Build common match filter
    const matchFilter: AnalyticsMatchFilter = {};
    if (statusParam && statusParam !== 'all') {
      matchFilter.status = statusParam;
    }

    const [
      ordersByCountry,
      ordersByWeekday,
      revenueByDayAgg,
      revenueByMonthAgg,
      ordersByStatusAgg,
      paymentTypeAgg,
      topProductsAgg,
    ] = await Promise.all([
      // Legacy chart: Orders by country
      Order.aggregate([
        {
          $match: {
            ...matchFilter,
            'billingData.country': { $exists: true, $ne: null },
          },
        },
        {
          $group: {
            _id: '$billingData.country',
            value: { $sum: 1 },
          },
        },
        {
          $sort: { value: -1 },
        },
        {
          $limit: 10,
        },
      ]),

      // Legacy chart: Orders by weekday
      Order.aggregate([
        {
          $match: {
            ...matchFilter,
            createdAt: { $exists: true },
          },
        },
        {
          $group: {
            _id: {
              dayOfWeek: { $dayOfWeek: '$createdAt' },
            },
            value: { $sum: 1 },
          },
        },
        {
          $sort: { '_id.dayOfWeek': 1 },
        },
      ]),

      // Revenue by day (last 30 days)
      Order.aggregate([
        {
          $match: {
            ...matchFilter,
            createdAt: { $gte: dayStart },
          },
        },
        {
          $group: {
            _id: {
              year: { $year: '$createdAt' },
              month: { $month: '$createdAt' },
              day: { $dayOfMonth: '$createdAt' },
            },
            revenue: { $sum: { $ifNull: ['$paidAmount', 0] } },
          },
        },
        {
          $sort: { '_id.year': 1, '_id.month': 1, '_id.day': 1 },
        },
      ]),

      // Revenue by month (last 12 months)
      Order.aggregate([
        {
          $match: {
            ...matchFilter,
            createdAt: { $gte: monthStart },
          },
        },
        {
          $group: {
            _id: {
              year: { $year: '$createdAt' },
              month: { $month: '$createdAt' },
            },
            revenue: { $sum: { $ifNull: ['$paidAmount', 0] } },
          },
        },
        {
          $sort: { '_id.year': 1, '_id.month': 1 },
        },
      ]),

      // Orders by status
      Order.aggregate([
        {
          $match: matchFilter,
        },
        {
          $group: {
            _id: '$status',
            value: { $sum: 1 },
          },
        },
      ]),

      // Full vs partial
      Order.aggregate([
        {
          $match: matchFilter,
        },
        {
          $group: {
            _id: {
              $cond: [{ $eq: ['$isPartialPayment', true] }, 'partial', 'full'],
            },
            value: { $sum: 1 },
          },
        },
      ]),

      // Top products by sold quantity
      Order.aggregate([
        {
          $match: matchFilter,
        },
        { $unwind: '$items' },
        {
          $group: {
            _id: '$items.productName.en',
            value: { $sum: { $ifNull: ['$items.quantity', 0] } },
          },
        },
        { $sort: { value: -1 } },
        { $limit: 10 },
      ]),
    ]);

    const weekdayNames = [
      'Sunday',
      'Monday',
      'Tuesday',
      'Wednesday',
      'Thursday',
      'Friday',
      'Saturday',
    ];

    const ordersByWeekdayData = ordersByWeekday.map(
      (item: { _id: { dayOfWeek: number }; value: number }) => ({
        name: weekdayNames[item._id.dayOfWeek - 1] || 'Unknown',
        value: item.value,
      }),
    );

    const ordersByCountryData = ordersByCountry.map(
      (item: { _id: string | null; value: number }) => ({
        name: item._id || 'Unknown',
        value: item.value,
      }),
    );

    const revenueByDayMap = new Map<string, number>(
      revenueByDayAgg.map(
        (item: {
          _id: { year: number; month: number; day: number };
          revenue: number;
        }) => {
          const key = `${item._id.year}-${String(item._id.month).padStart(2, '0')}-${String(item._id.day).padStart(2, '0')}`;
          return [key, item.revenue] as const;
        },
      ),
    );

    const revenueByMonthMap = new Map<string, number>(
      revenueByMonthAgg.map(
        (item: { _id: { year: number; month: number }; revenue: number }) => {
          const key = `${item._id.year}-${String(item._id.month).padStart(2, '0')}`;
          return [key, item.revenue] as const;
        },
      ),
    );

    const revenueByDay = buildDaySeries(revenueByDayMap, days);
    const revenueByMonth = buildMonthSeries(revenueByMonthMap, months);

    const statusOrder = [
      'pending',
      'processing',
      'paid',
      'completed',
      'failed',
      'refunded',
      'cancelled',
    ];

    const statusMap = new Map<string, number>(
      ordersByStatusAgg.map((item: { _id: string; value: number }) => [
        item._id,
        item.value,
      ]),
    );

    const ordersByStatus = statusOrder.map((status) => ({
      name: status,
      value: statusMap.get(status) ?? 0,
    }));

    const paymentTypeMap = new Map<string, number>(
      paymentTypeAgg.map((item: { _id: string; value: number }) => [
        item._id,
        item.value,
      ]),
    );

    const paymentTypeBreakdown = [
      { name: 'full', value: paymentTypeMap.get('full') ?? 0 },
      { name: 'partial', value: paymentTypeMap.get('partial') ?? 0 },
    ];

    const topProducts = topProductsAgg.map(
      (item: { _id: string | null; value: number }) => ({
        name: item._id || 'Unknown',
        value: item.value,
      }),
    );

    return NextResponse.json({
      success: true,
      data: {
        revenueByDay,
        revenueByMonth,
        ordersByStatus,
        paymentTypeBreakdown,
        topProducts,
        ordersByCountry: ordersByCountryData,
        ordersByWeekday: ordersByWeekdayData,
      },
    });
  } catch (error) {
    console.error('Error fetching analytics:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch analytics' },
      { status: 500 },
    );
  }
}
