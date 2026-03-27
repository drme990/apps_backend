import { NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import Product from '@/lib/models/Product';
import User from '@/lib/models/User';
import Order from '@/lib/models/Order';
import Country from '@/lib/models/Country';
import { getUserModelByAppId } from '@/lib/auth/app-users';

export async function GET() {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess('activityLogs');
    if ('error' in auth) return auth.error;

    const customerModelGhadaq = getUserModelByAppId('ghadaq');
    const customerModelManasik = getUserModelByAppId('manasik');

    const [
      totalProducts,
      totalUsers,
      totalOrders,
      totalCountries,
      totalCustomers,
    ] = await Promise.all([
      Product.countDocuments({ isDeleted: { $ne: true } }),
      User.countDocuments(),
      Order.countDocuments(),
      Country.countDocuments(),
      Promise.all([
        customerModelGhadaq.countDocuments(),
        customerModelManasik.countDocuments(),
      ]).then(([ghadaqCount, manasikCount]) => ghadaqCount + manasikCount),
    ]);

    return NextResponse.json({
      success: true,
      data: {
        totalProducts,
        totalUsers,
        totalOrders,
        totalCountries,
        totalCustomers,
      },
    });
  } catch (error) {
    console.error('Error fetching stats:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch stats' },
      { status: 500 },
    );
  }
}
