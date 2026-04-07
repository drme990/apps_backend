import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import Order from '@/lib/models/Order';

function hasOrderUserId(userId: unknown): boolean {
  if (typeof userId === 'string') return userId.trim().length > 0;
  if (typeof userId === 'object' && userId !== null) return true;
  return false;
}

export async function GET(request: NextRequest) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess('orders');
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
    const skip = (page - 1) * maxLimit;

    const query: Record<string, unknown> = {};
    if (status && status !== 'all') query.status = status;
    if (referralId && referralId !== 'all') query.referralId = referralId;
    if (source && source !== 'all') query.source = source;

    if (search) {
      query.$or = [
        { orderNumber: { $regex: search, $options: 'i' } },
        { 'billingData.fullName': { $regex: search, $options: 'i' } },
        { 'billingData.email': { $regex: search, $options: 'i' } },
        { 'billingData.phone': { $regex: search, $options: 'i' } },
      ];
    }

    const [orders, total] = await Promise.all([
      Order.find(query)
        .select({
          _id: 1,
          orderNumber: 1,
          userId: 1,
          isGuest: 1,
          items: 1,
          totalAmount: 1,
          currency: 1,
          status: 1,
          paymentMethod: 1,
          billingData: 1,
          couponCode: 1,
          couponDiscount: 1,
          fullAmount: 1,
          paidAmount: 1,
          remainingAmount: 1,
          isPartialPayment: 1,
          paymentType: 1,
          referralId: 1,
          termsAgreedAt: 1,
          source: 1,
          countryCode: 1,
          locale: 1,
          sizeIndex: 1,
          createdAt: 1,
          updatedAt: 1,
        })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(maxLimit)
        .lean(),
      Order.countDocuments(query),
    ]);

    const normalizedOrders = orders.map((order) => {
      const hasIsGuest = typeof order.isGuest === 'boolean';
      const hasUserId = hasOrderUserId(order.userId);

      return {
        ...order,
        isGuest: hasIsGuest ? order.isGuest : !hasUserId,
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
