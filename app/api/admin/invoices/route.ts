import { NextRequest, NextResponse } from 'next/server';
import type { PipelineStage } from 'mongoose';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import Order from '@/lib/models/Order';
import { buildAdminOrdersQuery } from '@/lib/order-filters';

export const maxDuration = 60;

const VALID_INVOICE_STATUSES = [
  'confirmed',
  'waiting',
  'pending',
  'rejected',
  'deleted',
] as const;

/**
 * GET /api/admin/invoices
 *
 * Returns flattened invoice rows (one row per invoiceUrls entry) with
 * real server-side pagination — no more fetching every order at once.
 *
 * Query params:
 *   page, limit          — pagination (limit capped at 200)
 *   review               — invoice status filter (confirmed|waiting|pending|rejected|deleted)
 *   paymentMethod        — derived payment method filter
 *   + every filter the orders endpoint accepts (status, search, source,
 *     referralId, category, intention, country, fromDate, toDate,
 *     dateField, tzOffsetMinutes)
 *
 * Sub-orders are excluded: their invoiceUrls are live-synced copies of
 * the parent's, so including them would duplicate every row. A parent
 * still surfaces its sub-order numbers via linkedOrderNumber, and a
 * search matching a sub-order number resolves to the parent.
 */
export async function GET(request: NextRequest) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess(['invoices']);
    if ('error' in auth) return auth.error;

    const { searchParams } = request.nextUrl;
    const page = Math.max(
      1,
      Number.parseInt(searchParams.get('page') || '1', 10) || 1,
    );
    const limit = Math.min(
      Math.max(1, Number.parseInt(searchParams.get('limit') || '25', 10) || 25),
      200,
    );
    const review = searchParams.get('review');
    const paymentMethod = searchParams.get('paymentMethod');

    // A search matching a sub-order's number should still surface the
    // parent's invoice rows — resolve matching subs to their parents and
    // OR it into the search condition.
    const search = searchParams.get('search');
    let extraSearchOr: Record<string, unknown>[] | undefined;
    if (search) {
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const matchingSubs = await Order.find(
        {
          isSubOrder: true,
          orderNumber: { $regex: escaped, $options: 'i' },
          parentOrderId: { $exists: true },
        },
        { parentOrderId: 1 },
      ).lean();
      const parentIds = matchingSubs
        .map((s) => s.parentOrderId)
        .filter(Boolean);
      if (parentIds.length > 0) {
        extraSearchOr = [{ _id: { $in: parentIds } }];
      }
    }

    const orderQuery = await buildAdminOrdersQuery(searchParams, {
      extraSearchOr,
    });
    // Sub-orders share the parent's synced invoiceUrls — normally excluded
    // to avoid duplicate rows, but when the admin explicitly filters for
    // sub-orders we keep them so the shared invoices are visible.
    if (searchParams.get('orderType') !== 'subOrder') {
      orderQuery.isSubOrder = { $ne: true };
    }
    orderQuery['invoiceUrls.0'] = { $exists: true };

    const reviewMatch: PipelineStage.FacetPipelineStage[] =
      review && (VALID_INVOICE_STATUSES as readonly string[]).includes(review)
        ? [{ $match: { normalizedInvoiceStatus: review } }]
        : [];

    const pipeline: PipelineStage[] = [
      { $match: orderQuery },
      {
        $unwind: {
          path: '$invoiceUrls',
          includeArrayIndex: 'invoiceIndex',
        },
      },
      {
        $addFields: {
          normalizedInvoiceStatus: {
            $cond: [
              {
                $in: [
                  '$invoiceUrls.invoiceStatus',
                  [...VALID_INVOICE_STATUSES],
                ],
              },
              '$invoiceUrls.invoiceStatus',
              'waiting',
            ],
          },
          // Latest paid payment — mirrors the page's derived paymentMethod
          latestPaidPayment: {
            $reduce: {
              input: {
                $filter: {
                  input: { $ifNull: ['$payments', []] },
                  as: 'p',
                  cond: { $eq: ['$$p.status', 'paid'] },
                },
              },
              initialValue: null,
              in: {
                $cond: [
                  {
                    $gt: [
                      '$$this.createdAt',
                      { $ifNull: ['$$value.createdAt', new Date(0)] },
                    ],
                  },
                  '$$this',
                  '$$value',
                ],
              },
            },
          },
        },
      },
      {
        $addFields: {
          derivedPaymentMethod: {
            $ifNull: ['$latestPaidPayment.paymentMethod', '$paymentMethod'],
          },
        },
      },
    ];

    // paymentMethod is an order-level attribute — applies to rows and stats
    if (paymentMethod && paymentMethod !== 'all') {
      pipeline.push({ $match: { derivedPaymentMethod: paymentMethod } });
    }

    pipeline.push({
      $facet: {
        rows: [
          ...reviewMatch,
          { $sort: { createdAt: -1, _id: 1 } },
          { $skip: (page - 1) * limit },
          { $limit: limit },
          {
            $project: {
              _id: {
                $concat: [
                  { $toString: '$_id' },
                  '_',
                  { $toString: '$invoiceIndex' },
                ],
              },
              orderId: { $toString: '$_id' },
              orderNumber: 1,
              isSubOrder: { $ifNull: ['$isSubOrder', false] },
              hasSubOrder: { $ifNull: ['$hasSubOrder', false] },
              invoiceIndex: 1,
              url: '$invoiceUrls.url',
              invoiceStatus: '$normalizedInvoiceStatus',
              rejectionReason: {
                $ifNull: ['$invoiceUrls.rejectionReason', ''],
              },
              value: { $ifNull: ['$invoiceUrls.value', 0] },
              currency: { $ifNull: ['$currency', ''] },
              invoiceCurrency: { $ifNull: ['$invoiceUrls.currency', 'EGP'] },
              orderStatus: '$status',
              customerName: { $ifNull: ['$billingData.fullName', ''] },
              customerEmail: { $ifNull: ['$billingData.email', ''] },
              customerPhone: { $ifNull: ['$billingData.phone', ''] },
              source: { $ifNull: ['$source', ''] },
              paymentMethod: '$derivedPaymentMethod',
              reservationData: 1,
              referralId: 1,
              items: 1,
              userId: 1,
              isGuest: 1,
              createdAt: 1,
              updatedAt: 1,
            },
          },
        ],
        total: [...reviewMatch, { $count: 'count' }],
        // Status breakdown across all matching invoices — not narrowed by
        // the review filter, so the stat chips keep showing the full picture
        statusCounts: [
          { $group: { _id: '$normalizedInvoiceStatus', count: { $sum: 1 } } },
        ],
      },
    });

    const result = await Order.aggregate(pipeline);
    const facet = result[0] || { rows: [], total: [], statusCounts: [] };
    const rows = (facet.rows || []) as Array<Record<string, unknown>>;
    const total = (facet.total?.[0]?.count as number) || 0;

    const statusCounts: Record<string, number> = {
      total: 0,
      confirmed: 0,
      waiting: 0,
      pending: 0,
      rejected: 0,
      deleted: 0,
    };
    for (const entry of (facet.statusCounts || []) as Array<{
      _id: string;
      count: number;
    }>) {
      statusCounts[entry._id] = entry.count;
      statusCounts.total += entry.count;
    }

    // Attach linkedOrderNumber: sub-order numbers for parent rows
    const parentIds = rows
      .filter((r) => r.hasSubOrder)
      .map((r) => String(r.orderId));
    if (parentIds.length > 0) {
      const subs = await Order.find(
        { parentOrderId: { $in: parentIds }, isSubOrder: true },
        { orderNumber: 1, parentOrderId: 1 },
      ).lean();
      const subNumbersByParent = new Map<string, string[]>();
      for (const sub of subs) {
        const pid = String(sub.parentOrderId);
        const list = subNumbersByParent.get(pid) || [];
        if (sub.orderNumber) list.push(sub.orderNumber);
        subNumbersByParent.set(pid, list);
      }
      for (const row of rows) {
        const numbers = subNumbersByParent.get(String(row.orderId));
        if (numbers && numbers.length > 0) {
          row.linkedOrderNumber = numbers.join(', ');
        }
      }
    }

    return NextResponse.json({
      success: true,
      data: {
        invoices: rows,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.max(1, Math.ceil(total / limit)),
        },
        statusCounts,
      },
    });
  } catch (error) {
    console.error('[Invoices API] Error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to load invoices' },
      { status: 500 },
    );
  }
}
