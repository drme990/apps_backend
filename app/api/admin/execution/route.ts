import { NextRequest, NextResponse } from 'next/server';
import mongoose, { type PipelineStage } from 'mongoose';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import Order from '@/lib/models/Order';
import Category from '@/lib/models/Categories';

/**
 * Execution orders API
 *
 * Returns all orders whose effective execution date falls within the requested range.
 *
 * HOW THE EXECUTION DATE IS DETERMINED (in order of priority):
 * 1. Order's own `reservationData.executionDate.value` — this is the single source
 *    of truth. Every new order gets this field filled at checkout time.
 * 2. Legacy fallback: `createdAt + 1 day` for orders created before the
 *    execution-date auto-fill logic existed.
 *
 * Only includes orders with status: paid, partial-paid.
 * Supports optional search, category, date range, referral, status filters, and pagination.
 */
export async function GET(request: NextRequest) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess(['orders', 'orderDesigns']);
    if ('error' in auth) return auth.error;

    const { searchParams } = request.nextUrl;
    const date = searchParams.get('date');
    const fromDate = searchParams.get('fromDate');
    const toDate = searchParams.get('toDate');
    const source = searchParams.get('source');
    const search = searchParams.get('search')?.trim();
    const categoryId = searchParams.get('category');
    const referralId = searchParams.get('referralId');
    const statusParam = searchParams.get('status');
    const intention = searchParams.get('intention');
    const country = searchParams.get('country');
    const pageParam = searchParams.get('page');
    const limitParam = searchParams.get('limit');
    const offsetParam = searchParams.get('offset');
    const globalSliceParam = searchParams.get('globalSlice');

    const page = Math.max(1, parseInt(pageParam || '1', 10));
    // Allow the "all" sentinel (10000) while keeping a safe cap for normal requests
    const limit = Math.max(1, Math.min(10000, parseInt(limitParam || '50', 10)));
    const offset = Math.max(0, parseInt(offsetParam || '0', 10));
    const skip = offset > 0 ? offset : (page - 1) * limit;
    const _useGlobalSlice = globalSliceParam === 'true';
    void _useGlobalSlice;

    const isoPattern = /^\d{4}-\d{2}-\d{2}$/;

    // Validate date params if provided
    if (date && !isoPattern.test(date)) {
      return NextResponse.json(
        { success: false, error: 'Invalid date format. Expected YYYY-MM-DD.' },
        { status: 400 },
      );
    }
    if (fromDate && !isoPattern.test(fromDate)) {
      return NextResponse.json(
        { success: false, error: 'Invalid fromDate format. Expected YYYY-MM-DD.' },
        { status: 400 },
      );
    }
    if (toDate && !isoPattern.test(toDate)) {
      return NextResponse.json(
        { success: false, error: 'Invalid toDate format. Expected YYYY-MM-DD.' },
        { status: 400 },
      );
    }

    // Only paid / partially paid orders should appear in execution
    const PAID_STATUSES = ['paid', 'partial-paid'];

    const baseMatch: Record<string, unknown> = {};
    if (statusParam && statusParam !== 'all' && PAID_STATUSES.includes(statusParam)) {
      baseMatch.status = statusParam;
    } else {
      baseMatch.status = { $in: PAID_STATUSES };
    }

    if (source && source !== 'all') {
      baseMatch.source = source;
    }
    if (referralId) {
      baseMatch.referralId = referralId;
    }
    if (country && country !== 'all') {
      baseMatch['billingData.country'] = {
        $regex: `^${country.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
        $options: 'i',
      };
    }

    // Category filter: look up category products then match order items.
    // The special value '__uncategorized__' matches orders whose product
    // is not assigned to any category (categoryId is null or missing).
    //
    // NOTE: items.productId in the Order schema is Mixed type — some orders
    // store it as a string, others as an ObjectId. MongoDB does NOT coerce
    // between strings and ObjectIds in $in/$nin, so we include BOTH forms
    // in the filter arrays to match regardless of how the order was stored.
    let categoryProductIds: (mongoose.Types.ObjectId | string)[] | undefined;
    let isUncategorizedFilter = false;
    if (categoryId && categoryId !== 'all') {
      if (categoryId === '__uncategorized__') {
        // Find all product IDs that ARE in a category, so we can exclude them
        isUncategorizedFilter = true;
        const allCategorizedProductIds = await Category.distinct('products');
        categoryProductIds = allCategorizedProductIds.flatMap((p) => {
          const str = typeof p === 'string' ? p : (p as { toString(): string }).toString();
          return [str, new mongoose.Types.ObjectId(str)];
        });
      } else {
        const category = await Category.findById(categoryId).select('products').lean();
        if (category && Array.isArray(category.products)) {
          categoryProductIds = category.products.flatMap((p) => {
            const str = typeof p === 'string' ? p : (p as { toString(): string }).toString();
            return [str, new mongoose.Types.ObjectId(str)];
          });
        }
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
    if (date && !fromDate && !toDate) {
      // Backward compat: single exact date
      dateFilter = { effectiveExecutionDate: date };
    } else if (fromDate || toDate) {
      const range: Record<string, unknown> = {};
      if (fromDate) range.$gte = fromDate;
      if (toDate) range.$lte = toDate;
      dateFilter = { effectiveExecutionDate: range };
    }

    // Aggregation pipeline (before pagination)
    const prePipeline: PipelineStage[] = [
      // 1. Base filter: paid statuses + source + referral
      { $match: baseMatch },
    ];

    // 1b. Category filter (if applicable)
    if (isUncategorizedFilter) {
      // Uncategorized: exclude orders that have ANY item with a categorized
      // product. An order is "uncategorized" only if ALL its items are
      // products not in any category.
      prePipeline.push({
        $match: {
          'items.productId': { $nin: categoryProductIds },
        },
      });
    } else if (categoryProductIds && categoryProductIds.length > 0) {
      prePipeline.push({
        $match: {
          'items.productId': { $in: categoryProductIds },
        },
      });
    }

    // 1c. Intention filter (if applicable)
    if (intention && intention !== 'all') {
      prePipeline.push({
        $match: {
          reservationData: {
            $elemMatch: {
              key: 'intention',
              value: intention,
            },
          },
        },
      });
    }

    // 1d. Search filter (if applicable)
    if (searchMatch) {
      prePipeline.push({ $match: searchMatch });
    }

    // 1e. Invoice filter:
    //     - Orders with NO invoices → show normally
    //     - Orders with invoices → ALL invoices must be "confirmed"
    //     - If any invoice is not confirmed → exclude the order
    //
    //     $not: { $elemMatch: { invoiceStatus: { $ne: 'confirmed' } } }
    //     means "no element has invoiceStatus != 'confirmed'".
    //     For empty/missing arrays $elemMatch fails → $not succeeds → included.
    prePipeline.push({
      $match: {
        invoiceUrls: {
          $not: { $elemMatch: { invoiceStatus: { $ne: 'confirmed' } } },
        },
      },
    });

    prePipeline.push(
      // 2. Safely extract executionDate.value from reservationData using $reduce.
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
      // New orders always have a persisted executionDate; fallback to createdAt+1 for legacy orders.
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

      // 4. Filter by execution date (range or exact)
      ...(dateFilter ? [{ $match: dateFilter }] : []),

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
          referralId: 1,
          createdAt: 1,
          reservationData: 1,
          effectiveExecutionDate: 1,
          fullAmount: 1,
          paidAmount: 1,
          remainingAmount: 1,
          isPartialPayment: 1,
          paymentType: 1,
          isWhatsappButtonClicked: 1,
          statusUpdateTime: 1,
          updatedAt: 1,
          executionNumber: 1,
          invoiceUrls: 1,
          designUrls: 1,
          payments: 1,
          internalNotes: 1,
        },
      },

      // 5b. Normalize executionNumber for sorting so unnumbered orders don't
      // appear before numbered ones while the backfill is still running.
      {
        $addFields: {
          sortExecutionNumber: {
            $ifNull: ['$executionNumber', Number.MAX_SAFE_INTEGER],
          },
        },
      },

      // 6. Sort by execution date, then execution number, then creation time.
      // This keeps the 1..N daily sequence visually consistent in the table.
      { $sort: { effectiveExecutionDate: 1, sortExecutionNumber: 1, createdAt: 1 } },
    );

    // Use $facet to get total count and paginated orders in one query
    const facetPipeline = [
      ...prePipeline,
      {
        $facet: {
          totalCount: [{ $count: 'count' }],
          orders: [{ $skip: skip }, { $limit: limit }],
        },
      },
    ];

    const facetResult = await Order.aggregate(facetPipeline);
    const totalCount = facetResult[0]?.totalCount[0]?.count || 0;
    const orders = facetResult[0]?.orders || [];

    const normalizedOrders = orders.map((order: Record<string, unknown>) => {
      const rawInvoices = order.invoiceUrls as Array<{ url: string; invoiceStatus?: string; rejectionReason?: string; value?: number; currency?: string }> | undefined;
      return {
        ...order,
        invoiceUrls: (rawInvoices || []).map((invoice) => ({
          url: invoice.url,
          invoiceStatus: ['confirmed', 'waiting', 'pending', 'rejected'].includes(invoice.invoiceStatus || '') ? invoice.invoiceStatus : 'waiting',
          rejectionReason: invoice.rejectionReason || '',
          value: typeof invoice.value === 'number' ? invoice.value : 0,
          currency: invoice.currency || 'EGP',
        })),
      };
    });

    return NextResponse.json({
      success: true,
      data: {
        orders: normalizedOrders,
        pagination: {
          page,
          limit,
          totalOrders: totalCount,
          totalPages: Math.ceil(totalCount / limit),
        },
        date,
        fromDate,
        toDate,
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
