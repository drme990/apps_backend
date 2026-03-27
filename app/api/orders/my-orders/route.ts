import { NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { getAuthUser } from '@/lib/auth';
import Order from '@/lib/models/Order';

export async function GET() {
  try {
    await connectDB();

    // Try to get authenticated user from either app
    let user = await getAuthUser('ghadaq');
    if (!user) {
      user = await getAuthUser('manasik');
    }

    if (!user) {
      return NextResponse.json(
        { success: false, error: 'Authentication required' },
        { status: 401 },
      );
    }

    const appId = user.appId;

    // Find orders by userId or by email (for backward compatibility)
    const orders = await Order.find({
      $or: [
        { userId: user.userId },
        { 'billingData.email': user.email.toLowerCase() },
      ],
      source: appId,
    })
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();

    const normalized = orders.map((order) => {
      const firstItem = order.items?.[0];
      const productName =
        firstItem?.productName?.en || firstItem?.productName?.ar || 'N/A';

      // Determine payment status
      let paymentStatus = 'Pending Payment';
      if (order.status === 'paid') {
        paymentStatus = 'Paid';
      } else if (
        order.remainingAmount &&
        order.remainingAmount > 0 &&
        order.paidAmount &&
        order.paidAmount > 0
      ) {
        paymentStatus = 'Partially Paid';
      } else if (order.status === 'failed') {
        paymentStatus = 'Failed';
      }

      return {
        _id: String(order._id),
        orderNumber: order.orderNumber,
        product: {
          name: productName,
          slug: firstItem?.productSlug,
        },
        quantity: firstItem?.quantity || 1,
        fullAmount: order.fullAmount || order.totalAmount,
        paidAmount: order.paidAmount || 0,
        remainingAmount: order.remainingAmount || 0,
        currency: order.currency,
        totalPrice: order.totalAmount,
        status: order.status,
        paymentStatus,
        isPartialPayment: order.isPartialPayment,
        createdAt: order.createdAt,
        items: order.items,
        reservationData: order.reservationData,
        billingData: order.billingData,
      };
    });

    return NextResponse.json({ success: true, data: normalized });
  } catch (error) {
    console.error('Error fetching user orders:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch orders' },
      { status: 500 },
    );
  }
}
