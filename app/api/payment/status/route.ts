import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import Order from '@/lib/models/Order';
import Referral from '@/lib/models/Referral';

export async function GET(request: NextRequest) {
  try {
    await connectDB();
    const orderNumber = request.nextUrl.searchParams.get('orderNumber');

    if (!orderNumber) {
      return NextResponse.json(
        { success: false, error: 'Missing orderNumber parameter' },
        { status: 400 },
      );
    }

    const order = await Order.findOne({ orderNumber }).lean();

    if (!order) {
      return NextResponse.json(
        { success: false, error: 'Order not found' },
        { status: 404 },
      );
    }

    let referralInfo: { name: string; phone: string } | null = null;
    if (order.referralId) {
      const referral = await Referral.findOne({
        referralId: order.referralId,
      }).lean();
      if (referral) {
        referralInfo = {
          name: referral.name as string,
          phone: referral.phone as string,
        };
      }
    }

    return NextResponse.json({
      success: true,
      data: {
        orderNumber: order.orderNumber,
        status: order.status,
        totalAmount: order.totalAmount,
        currency: order.currency,
        items: order.items,
        billingData: order.billingData,
        couponCode: order.couponCode || null,
        couponDiscount: order.couponDiscount || 0,
        isPartialPayment: order.isPartialPayment || false,
        fullAmount: order.fullAmount || order.totalAmount,
        paidAmount: order.paidAmount || order.totalAmount,
        remainingAmount: order.remainingAmount || 0,
        reservationData: order.reservationData || [],
        source: order.source || 'manasik',
        referralInfo,
        createdAt: order.createdAt,
      },
    });
  } catch (error) {
    console.error('Error fetching payment status:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch payment status' },
      { status: 500 },
    );
  }
}
