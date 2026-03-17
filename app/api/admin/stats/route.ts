import { NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAuth } from '@/lib/auth';
import Product from '@/lib/models/Product';
import User from '@/lib/models/User';
import Order from '@/lib/models/Order';
import Country from '@/lib/models/Country';

export async function GET() {
  try {
    await connectDB();
    const auth = await requireAuth();
    if ('error' in auth) return auth.error;

    const [totalProducts, totalUsers, totalOrders, totalCountries] =
      await Promise.all([
        Product.countDocuments({ isDeleted: { $ne: true } }),
        User.countDocuments(),
        Order.countDocuments(),
        Country.countDocuments(),
      ]);

    return NextResponse.json({
      success: true,
      data: { totalProducts, totalUsers, totalOrders, totalCountries },
    });
  } catch (error) {
    console.error('Error fetching stats:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch stats' },
      { status: 500 },
    );
  }
}
