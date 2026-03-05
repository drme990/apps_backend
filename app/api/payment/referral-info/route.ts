import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import Order from '@/lib/models/Order';
import Referral from '@/lib/models/Referral';

export async function GET(request: NextRequest) {
  try {
    await connectDB();
    const orderNumber = request.nextUrl.searchParams.get('orderNumber');

    if (!orderNumber) {
      return NextResponse.json({ success: true, data: null });
    }

    const order = await Order.findOne({ orderNumber });

    if (!order || !order.referralId) {
      return NextResponse.json({ success: true, data: null });
    }

    const referral = await Referral.findOne({ referralId: order.referralId });

    if (!referral) {
      return NextResponse.json({ success: true, data: null });
    }

    return NextResponse.json({
      success: true,
      data: { name: referral.name, phone: referral.phone },
    });
  } catch (error) {
    console.error('Error fetching referral info:', error);
    return NextResponse.json({ success: true, data: null });
  }
}
