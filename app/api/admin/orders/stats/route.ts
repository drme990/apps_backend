import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import Order from '@/lib/models/Order';

function parseIsoDateParts(
  value: string | null,
): { year: number; month: number; day: number } | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;

  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));

  if (Number.isNaN(date.getTime())) return null;
  return { year, month, day };
}

function parseTimezoneOffsetMinutes(value: string | null): number {
  const parsed = Number.parseInt(value || '', 10);
  if (Number.isNaN(parsed)) return 0;

  if (parsed < -840 || parsed > 840) return 0;
  return parsed;
}

function getUtcStartOfLocalDay(
  dateParts: { year: number; month: number; day: number },
  timezoneOffsetMinutes: number,
): Date {
  const utcMidnightMs = Date.UTC(
    dateParts.year,
    dateParts.month - 1,
    dateParts.day,
    0,
    0,
    0,
    0,
  );
  return new Date(utcMidnightMs + timezoneOffsetMinutes * 60 * 1000);
}

export async function GET(request: NextRequest) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess('orders');
    if ('error' in auth) return auth.error;

    const { searchParams } = request.nextUrl;
    const status = searchParams.get('status');
    const referralId = searchParams.get('referralId');
    const search = searchParams.get('search');
    const source = searchParams.get('source');
    const whatsappState = searchParams.get('whatsappState');
    const specificDate = searchParams.get('date');
    const fromDate = searchParams.get('fromDate');
    const toDate = searchParams.get('toDate');
    const timezoneOffsetMinutes = parseTimezoneOffsetMinutes(
      searchParams.get('tzOffsetMinutes'),
    );

    const query: Record<string, unknown> = {};
    const andConditions: Record<string, unknown>[] = [];

    if (status && status !== 'all') query.status = status;
    if (referralId && referralId !== 'all') {
      if (
        referralId === 'default' ||
        referralId === 'MNK-D' ||
        referralId === 'GHD-D'
      ) {
        const sourceCondition =
          referralId === 'MNK-D'
            ? {
              $or: [
                { source: 'manasik' },
                { source: { $exists: false } },
                { source: null },
                { source: '' },
              ],
            }
            : referralId === 'GHD-D'
              ? { source: 'ghadaq' }
              : null;

        andConditions.push({
          $or: [
            { referralId: { $exists: false } },
            { referralId: null },
            { referralId: '' },
            { referralId: referralId },
          ],
        });

        if (sourceCondition) {
          andConditions.push(sourceCondition);
        }
      } else {
        query.referralId = referralId;
      }
    }
    if (source && source !== 'all') query.source = source;
    if (whatsappState && whatsappState !== 'all') {
      query.isWhatsappButtonClicked = whatsappState;
    }

    if (search) {
      andConditions.push({
        $or: [
          { orderNumber: { $regex: search, $options: 'i' } },
          { 'billingData.fullName': { $regex: search, $options: 'i' } },
          { 'billingData.email': { $regex: search, $options: 'i' } },
          { 'billingData.phone': { $regex: search, $options: 'i' } },
        ],
      });
    }

    const updatedAtFilter: Record<string, Date> = {};
    const parsedSpecificDate = parseIsoDateParts(specificDate);

    if (parsedSpecificDate) {
      const start = getUtcStartOfLocalDay(
        parsedSpecificDate,
        timezoneOffsetMinutes,
      );
      const endExclusive = new Date(start);
      endExclusive.setDate(endExclusive.getDate() + 1);
      updatedAtFilter.$gte = start;
      updatedAtFilter.$lt = endExclusive;
    } else {
      const parsedFromDate = parseIsoDateParts(fromDate);
      const parsedToDate = parseIsoDateParts(toDate);

      if (parsedFromDate) {
        updatedAtFilter.$gte = getUtcStartOfLocalDay(
          parsedFromDate,
          timezoneOffsetMinutes,
        );
      }

      if (parsedToDate) {
        const toDateStart = getUtcStartOfLocalDay(
          parsedToDate,
          timezoneOffsetMinutes,
        );
        const toDateEndExclusive = new Date(toDateStart);
        toDateEndExclusive.setDate(toDateEndExclusive.getDate() + 1);
        updatedAtFilter.$lt = toDateEndExclusive;
      }
    }

    if (Object.keys(updatedAtFilter).length > 0) {
      query.statusUpdateTime = updatedAtFilter;
    }

    if (andConditions.length > 0) {
      query.$and = andConditions;
    }

    const pipeline: any[] = [
      { $match: query },
      { $unwind: '$items' },
      {
        $lookup: {
          from: 'products',
          localField: 'items.productId',
          foreignField: '_id',
          as: 'productInfo',
        },
      },
      {
        $addFields: {
          categoryId: { $arrayElemAt: ['$productInfo.categoryId', 0] },
        },
      },
      {
        $lookup: {
          from: 'categories',
          let: { catId: '$categoryId' },
          pipeline: [
            { $match: { $expr: { $eq: ['$_id', '$$catId'] } } },
            { $project: { name: 1, categoryNumber: 1, color: 1 } },
          ],
          as: 'categoryInfo',
        },
      },
      {
        $addFields: {
          categoryName: { $arrayElemAt: ['$categoryInfo.name', 0] },
          categoryNumber: {
            $ifNull: [
              { $arrayElemAt: ['$categoryInfo.categoryNumber', 0] },
              9999,
            ],
          },
          color: { $arrayElemAt: ['$categoryInfo.color', 0] },
        },
      },
      // Group by category + product to get per-product counts
      {
        $group: {
          _id: {
            categoryId: { $ifNull: ['$categoryId', '__uncategorized__'] },
            productId: '$items.productId',
          },
          quantity: { $sum: '$items.quantity' },
          productNameAr: { $first: '$items.productName.ar' },
          productNameEn: { $first: '$items.productName.en' },
          categoryName: { $first: '$categoryName' },
          categoryNumber: { $first: '$categoryNumber' },
          color: { $first: '$color' },
        },
      },
      // Group by category to collect products and category total
      {
        $group: {
          _id: '$_id.categoryId',
          categoryName: { $first: '$categoryName' },
          categoryNumber: { $first: '$categoryNumber' },
          color: { $first: '$color' },
          totalItems: { $sum: '$quantity' },
          products: {
            $push: {
              productId: { $toString: '$_id.productId' },
              productName: {
                ar: '$productNameAr',
                en: '$productNameEn',
              },
              quantity: '$quantity',
            },
          },
        },
      },
      { $sort: { categoryNumber: 1 } },
      {
        $project: {
          _id: 0,
          categoryId: { $toString: '$_id' },
          categoryName: { $ifNull: ['$categoryName', 'Uncategorized'] },
          categoryNumber: 1,
          totalItems: 1,
          color: { $ifNull: ['$color', '#9CA3AF'] },
          products: 1,
        },
      },
    ];

    const results = await Order.aggregate(pipeline);

    const totalItems = results.reduce(
      (sum, cat) => sum + (cat.totalItems || 0),
      0,
    );

    const byCategory = results.map((cat) => ({
      ...cat,
      percentage: totalItems > 0 ? Math.round((cat.totalItems / totalItems) * 1000) / 10 : 0,
    }));

    return NextResponse.json({
      success: true,
      data: {
        totalItems,
        byCategory,
      },
    });
  } catch (error) {
    console.error('Error fetching order stats:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch order stats' },
      { status: 500 },
    );
  }
}
