import { NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { getAuthUser } from '@/lib/auth';
import Order from '@/lib/models/Order';
import { getEasykashCashExpiryHours } from '@/lib/services/easykash';
import { calculateOrderFinancials } from '@/lib/services/order-financials';

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

    const now = Date.now();
    const cashExpiryWindowMs = getEasykashCashExpiryHours() * 60 * 60 * 1000;

    const normalized = orders
      .map((order) => {
        const firstItem = order.items?.[0];
        const productName =
          firstItem?.productName?.en || firstItem?.productName?.ar || 'N/A';

        const { fullAmount, totalPaid, remainingAmount } =
          calculateOrderFinancials(order);
        const hasPaymentRecords =
          Array.isArray(order.payments) && order.payments.length > 0;

        const paidAmount = hasPaymentRecords
          ? totalPaid
          : order.paidAmount || 0;
        const resolvedRemainingAmount = hasPaymentRecords
          ? remainingAmount
          : Math.max(0, order.remainingAmount || 0);

        const hasActivePendingPayment = (order.payments || []).some(
          (payment) =>
            payment.status === 'pending' &&
            !!payment.redirectUrl &&
            !!payment.expiresAt &&
            new Date(payment.expiresAt).getTime() > now &&
            (!payment.createdAt ||
              new Date(payment.createdAt).getTime() + cashExpiryWindowMs > now),
        );

        const canCompleteOrder =
          order.status === 'processing' &&
          hasActivePendingPayment &&
          paidAmount <= 0;

        const canPayRemainingAmount =
          resolvedRemainingAmount > 0 &&
          paidAmount > 0 &&
          order.status !== 'cancelled' &&
          order.status !== 'refunded';

        // Determine payment status
        let paymentStatus = 'Pending Payment';
        if (order.status === 'paid') {
          paymentStatus = 'Paid';
        } else if (
          (order.status === 'processing' || order.status === 'partial-paid') &&
          resolvedRemainingAmount > 0 &&
          paidAmount > 0
        ) {
          paymentStatus = 'Partially Paid';
        } else if (resolvedRemainingAmount > 0 && paidAmount > 0) {
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
          fullAmount,
          paidAmount,
          remainingAmount: resolvedRemainingAmount,
          currency: order.currency,
          totalPrice: order.totalAmount,
          status: order.status,
          paymentStatus,
          isPartialPayment: order.isPartialPayment,
          hasActivePendingPayment,
          canCompleteOrder,
          canPayRemainingAmount,
          createdAt: order.createdAt,
          items: order.items,
          reservationData: order.reservationData,
          billingData: order.billingData,
        };
      })
      .filter((order) => {
        if (
          order.status === 'paid' ||
          order.status === 'completed' ||
          order.status === 'refunded' ||
          order.status === 'cancelled'
        ) {
          return true;
        }

        if (order.status === 'processing') {
          return (
            order.hasActivePendingPayment || (order.remainingAmount || 0) > 0
          );
        }

        if (order.status === 'partial-paid') {
          return (order.remainingAmount || 0) > 0;
        }

        return false;
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
