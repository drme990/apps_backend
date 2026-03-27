import { NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { getAuthUser } from '@/lib/auth';
import Order from '@/lib/models/Order';

async function resolveAppUser() {
  const ghadq = await getAuthUser('ghadaq');
  if (ghadq) return ghadq;

  const manasik = await getAuthUser('manasik');
  if (manasik) return manasik;

  return null;
}

export async function GET() {
  try {
    await connectDB();

    const user = await resolveAppUser();
    if (!user) {
      return NextResponse.json(
        { success: false, error: 'Authentication required' },
        { status: 401 },
      );
    }

    const orders = await Order.find({
      source: user.appId,
      'billingData.email': user.email.toLowerCase(),
    })
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();

    const normalized = orders.map((order) => {
      const firstItem = order.items?.[0];
      const productName =
        firstItem?.productName?.en || firstItem?.productName?.ar || 'N/A';

      return {
        _id: String(order._id),
        orderNumber: order.orderNumber,
        product: { name: productName },
        quantity: firstItem?.quantity || 1,
        totalPrice: order.totalAmount,
        status: order.status,
        createdAt: order.createdAt,
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
