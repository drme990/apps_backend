import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import Order from '@/lib/models/Order';
import { buildAdminOrdersQuery } from '@/lib/order-filters';

function hasOrderUserId(userId: unknown): boolean {
  if (typeof userId === 'string') return userId.trim().length > 0;
  if (typeof userId === 'object' && userId !== null) return true;
  return false;
}

export async function GET(request: NextRequest) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess(['orders', 'invoices', 'orderDesigns']);
    if ('error' in auth) return auth.error;

    const { searchParams } = request.nextUrl;
    const page = parseInt(searchParams.get('page') || '1');
    const limit = parseInt(searchParams.get('limit') || '20');
    // Allow the "all" sentinel (10000) while keeping a safe cap for normal requests
    const maxLimit = Math.min(limit, 10000);
    const viewMode = searchParams.get('view') || 'full';
    const skip = (page - 1) * maxLimit;

    const query = await buildAdminOrdersQuery(searchParams);

    const tableProjection = {
      _id: 1,
      orderNumber: 1,
      userId: 1,
      isGuest: 1,
      'items.productName': 1,
      'items.quantity': 1,
      'items.price': 1,
      'items.currency': 1,
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
      isFreeOrder: 1,
      parentOrderId: 1,
      isSubOrder: 1,
      hasSubOrder: 1,
      subOrderId: 1,
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
      source: 1,
      location: 1,
      locale: 1,
      createdAt: 1,
      updatedAt: 1,
      statusUpdateTime: 1,
      payments: 1,
      invoiceUrls: 1,
      isFreeOrder: 1,
      freeOrderReason: 1,
      createdByAdminId: 1,
      createdByAdminEmail: 1,
      createdByAdminName: 1,
      parentOrderId: 1,
      isSubOrder: 1,
      hasSubOrder: 1,
      subOrderId: 1,
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

      const invoiceUrls = ((order.invoiceUrls || []) as Array<{ url: string; invoiceStatus?: string; rejectionReason?: string; value?: number; currency?: string }>)
        .map((invoice) => ({
          url: invoice.url,
          invoiceStatus: ['confirmed', 'waiting', 'pending', 'rejected', 'deleted'].includes(invoice.invoiceStatus || '') ? invoice.invoiceStatus : 'waiting',
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

    // ── Merge shared data for sub-orders ──
    // Sub-orders share invoiceUrls and payments with their parent.
    // Fetch parents in batch and merge those fields into sub-order responses.
    // Also fetch the linked order's orderNumber for both sub-orders and parents
    // so the frontend can display both order numbers on invoice rows.
    const subOrderParentIds = normalizedOrders
      .filter((o) => o.isSubOrder && o.parentOrderId)
      .map((o) => String(o.parentOrderId));
    const parentIdsWithSubs = normalizedOrders
      .filter((o) => o.hasSubOrder)
      .map((o) => String(o._id));

    if (subOrderParentIds.length > 0) {
      const parents = await Order.find(
        { _id: { $in: subOrderParentIds } },
        { invoiceUrls: 1, payments: 1, orderNumber: 1 },
      ).lean();
      const parentMap = new Map(
        parents.map((p) => [String(p._id), p]),
      );
      for (const order of normalizedOrders) {
        if (order.isSubOrder && order.parentOrderId) {
          const parent = parentMap.get(String(order.parentOrderId));
          if (parent) {
            order.invoiceUrls = parent.invoiceUrls as typeof order.invoiceUrls;
            order.payments = parent.payments as typeof order.payments;
            (order as Record<string, unknown>).linkedOrderNumber = parent.orderNumber;
          }
        }
      }
    }

    if (parentIdsWithSubs.length > 0) {
      const subOrders = await Order.find(
        { parentOrderId: { $in: parentIdsWithSubs }, isSubOrder: true },
        { orderNumber: 1, parentOrderId: 1 },
      ).lean();
      const subNumbersByParent = new Map<string, string[]>();
      for (const sub of subOrders) {
        const pid = String(sub.parentOrderId);
        const list = subNumbersByParent.get(pid) || [];
        if (sub.orderNumber) list.push(sub.orderNumber);
        subNumbersByParent.set(pid, list);
      }
      for (const order of normalizedOrders) {
        if (order.hasSubOrder) {
          const numbers = subNumbersByParent.get(String(order._id));
          if (numbers && numbers.length > 0) {
            (order as Record<string, unknown>).linkedOrderNumber = numbers.join(', ');
          }
        }
      }
    }

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
