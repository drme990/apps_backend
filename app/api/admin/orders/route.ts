import { NextRequest, NextResponse } from 'next/server';
import mongoose from 'mongoose';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import Order from '@/lib/models/Order';
import Category from '@/lib/models/Categories';

function hasOrderUserId(userId: unknown): boolean {
  if (typeof userId === 'string') return userId.trim().length > 0;
  if (typeof userId === 'object' && userId !== null) return true;
  return false;
}

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

  // Real-world timezone offsets typically fall between UTC-12 and UTC+14.
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
    const auth = await requireAdminPageAccess(['orders', 'invoices']);
    if ('error' in auth) return auth.error;

    const { searchParams } = request.nextUrl;
    const page = parseInt(searchParams.get('page') || '1');
    const limit = parseInt(searchParams.get('limit') || '20');
    // Enforce hard limit to prevent OOM
    const maxLimit = limit > 200 ? 200 : limit;
    const status = searchParams.get('status');
    const referralId = searchParams.get('referralId');
    const search = searchParams.get('search');
    const source = searchParams.get('source');
    const whatsappState = searchParams.get('whatsappState');
    const categoryId = searchParams.get('category');
    const intention = searchParams.get('intention');
    const viewMode = searchParams.get('view') || 'full';
    const specificDate = searchParams.get('date');
    const fromDate = searchParams.get('fromDate');
    const toDate = searchParams.get('toDate');
    const timezoneOffsetMinutes = parseTimezoneOffsetMinutes(
      searchParams.get('tzOffsetMinutes'),
    );
    const skip = (page - 1) * maxLimit;

    // Category filter: resolve category products to match order items
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

    if (categoryProductIds && categoryProductIds.length > 0) {
      andConditions.push({
        'items.productId': { $in: categoryProductIds },
      });
    }

    if (intention && intention !== 'all') {
      andConditions.push({
        reservationData: {
          $elemMatch: {
            key: 'intention',
            value: intention,
          },
        },
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

    const tableProjection = {
      _id: 1,
      orderNumber: 1,
      userId: 1,
      isGuest: 1,
      'items.productName': 1,
      'items.quantity': 1,
      totalAmount: 1,
      paidAmount: 1,
      currency: 1,
      status: 1,
      'billingData.fullName': 1,
      'billingData.email': 1,
      'billingData.phone': 1,
      'billingData.country': 1,
      referralId: 1,
      isWhatsappButtonClicked: 1,
      remainingAmount: 1,
      source: 1,
      invoiceUrls: 1,
      reservationData: 1,
      createdAt: 1,
      updatedAt: 1,
      statusUpdateTime: 1,
      payments: 1,
      paymentMethod: 1,
    };

    const fullProjection = {
      _id: 1,
      orderNumber: 1,
      userId: 1,
      isGuest: 1,
      items: 1,
      totalAmount: 1,
      currency: 1,
      status: 1,
      billingData: 1,
      couponCode: 1,
      couponDiscount: 1,
      fullAmount: 1,
      paidAmount: 1,
      remainingAmount: 1,
      isPartialPayment: 1,
      paymentType: 1,
      referralId: 1,
      isWhatsappButtonClicked: 1,
      termsAgreedAt: 1,
      source: 1,
      location: 1,
      locale: 1,
      createdAt: 1,
      updatedAt: 1,
      statusUpdateTime: 1,
      payments: 1,
      invoiceUrls: 1,
    };

    const [orders, total] = await Promise.all([
      Order.find(query)
        .select(viewMode === 'table' ? tableProjection : fullProjection)
        .sort({ statusUpdateTime: -1, updatedAt: -1 })
        .skip(skip)
        .limit(maxLimit)
        .lean(),
      Order.countDocuments(query),
    ]);

    const normalizedOrders = orders.map((order) => {
      const hasIsGuest = typeof order.isGuest === 'boolean';
      const hasUserId = hasOrderUserId(order.userId);

      const normalizedReferralId =
        order.referralId === 'MNK-D' || order.referralId === 'GHD-D'
          ? undefined
          : order.referralId;

      const invoiceUrls = ((order.invoiceUrls || []) as Array<{ url: string; invoiceStatus?: string; rejectionReason?: string; value?: number; currency?: string }>).map((invoice) => ({
        url: invoice.url,
        invoiceStatus: ['confirmed', 'waiting', 'pending', 'rejected'].includes(invoice.invoiceStatus || '') ? invoice.invoiceStatus : 'waiting',
        rejectionReason: invoice.rejectionReason || '',
        value: typeof invoice.value === 'number' ? invoice.value : 0,
        currency: invoice.currency || 'EGP',
      }));

      return {
        ...order,
        invoiceUrls,
        isGuest: hasIsGuest ? order.isGuest : !hasUserId,
        referralId: normalizedReferralId,
      };
    });

    const totalPages = Math.ceil(total / maxLimit);

    return NextResponse.json({
      success: true,
      data: {
        orders: normalizedOrders,
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
    console.error('Error fetching orders:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch orders' },
      { status: 500 },
    );
  }
}
