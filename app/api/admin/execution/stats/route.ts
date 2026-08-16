/**
 * Execution stats API
 *
 * Aggregates execution data grouped by category and product.
 *
 * HOW THE EXECUTION DATE IS DETERMINED (same as the main execution route):
 * 1. Order's own `reservationData.executionDate.value` — primary source of truth.
 * 2. Legacy fallback: `createdAt + 1 day` for pre-auto-fill orders.
 */
import { NextRequest, NextResponse } from 'next/server';
import mongoose, { type PipelineStage } from 'mongoose';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import Order from '@/lib/models/Order';
import Category from '@/lib/models/Categories';

export async function GET(request: NextRequest) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess(['orders', 'orderDesigns']);
    if ('error' in auth) return auth.error;

    const { searchParams } = request.nextUrl;
    const statusParam = searchParams.get('status');
    const source = searchParams.get('source');
    const search = searchParams.get('search')?.trim();
    const categoryId = searchParams.get('category');
    const referralId = searchParams.get('referralId');
    const intention = searchParams.get('intention');
    const country = searchParams.get('country');
    const fromDate = searchParams.get('fromDate');
    const toDate = searchParams.get('toDate');

    const isoPattern = /^\d{4}-\d{2}-\d{2}$/;

    // Build base match like the main execution route
    const baseMatch: Record<string, unknown> = {};
    if (statusParam && statusParam !== 'all') {
      baseMatch.status = statusParam;
    } else {
      baseMatch.status = { $in: ['paid', 'partial-paid'] };
    }

    if (source && source !== 'all') {
      baseMatch.source = source;
    }
    if (referralId) {
      baseMatch.referralId = referralId;
    }

    // Category filter: look up category products then match order items
    let categoryProductIds: mongoose.Types.ObjectId[] | undefined;
    if (categoryId && categoryId !== 'all') {
      const category = await Category.findById(categoryId).select('products').lean();
      if (category && Array.isArray(category.products)) {
        categoryProductIds = category.products.map((p) => {
          const str = typeof p === 'string' ? p : (p as { toString(): string }).toString();
          return new mongoose.Types.ObjectId(str);
        });
      }
    }

    // Build search regex if provided
    let searchMatch: Record<string, unknown> | undefined;
    if (search) {
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = { $regex: escaped, $options: 'i' };
      searchMatch = {
        $or: [
          { orderNumber: regex },
          { 'billingData.fullName': regex },
          { 'billingData.phone': regex },
          { 'billingData.email': regex },
          { 'reservationData.value': regex },
        ],
      };
    }

    // Build date filter for effectiveExecutionDate
    let dateFilter: Record<string, unknown> | undefined;
    if (fromDate || toDate) {
      const range: Record<string, unknown> = {};
      if (fromDate && isoPattern.test(fromDate)) range.$gte = fromDate;
      if (toDate && isoPattern.test(toDate)) range.$lte = toDate;
      if (Object.keys(range).length > 0) {
        dateFilter = { effectiveExecutionDate: range };
      }
    }

    const prePipeline = [
      { $match: baseMatch },
      ...(searchMatch ? [{ $match: searchMatch }] : []),
      ...(categoryProductIds && categoryProductIds.length > 0
        ? [
          {
            $match: {
              'items.productId': { $in: categoryProductIds },
            },
          },
        ]
        : []),
      ...(intention && intention !== 'all'
        ? [
          {
            $match: {
              reservationData: {
                $elemMatch: {
                  key: 'intention',
                  value: intention,
                },
              },
            },
          },
        ]
        : []),
      ...(country && country !== 'all' ? [{ $match: { 'billingData.country': { $regex: `^${country.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' } } }] : []),
      // Compute executionDateValue from reservationData
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
      // Compute effectiveExecutionDate
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
      ...(dateFilter ? [{ $match: dateFilter }] : []),
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
      // Group by category + product + size to get per-product/size counts
      {
        $group: {
          _id: {
            categoryId: { $ifNull: ['$categoryId', '__uncategorized__'] },
            productId: '$items.productId',
            sizeKey: { $ifNull: ['$items.sizeName', '$items.sizeLabel', '$items.size', null] },
          },
          quantity: { $sum: '$items.quantity' },
          productNameAr: { $first: '$items.productName.ar' },
          productNameEn: { $first: '$items.productName.en' },
          sizeName: { $first: '$items.sizeName' },
          sizeLabel: { $first: '$items.sizeLabel' },
          size: { $first: '$items.size' },
          sizeIndex: { $first: '$items.sizeIndex' },
          sizes: { $first: '$items.sizes' },
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
              sizeName: '$sizeName',
              sizeLabel: '$sizeLabel',
              size: '$size',
              sizeIndex: '$sizeIndex',
              sizes: '$sizes',
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
    ] as PipelineStage[];

    const results = await Order.aggregate(prePipeline);

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
    console.error('Error fetching execution stats:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch execution stats' },
      { status: 500 },
    );
  }
}
