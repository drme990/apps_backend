import { NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import Product from '@/lib/models/Product';
import User from '@/lib/models/User';
import Order from '@/lib/models/Order';
import Country from '@/lib/models/Country';
import { getUserModelByAppId } from '@/lib/auth/app-users';

function getTomorrowDate(): string {
  const now = new Date();
  const tomorrow = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate() + 1));
  return tomorrow.toISOString().slice(0, 10);
}

export async function GET() {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess('activityLogs');
    if ('error' in auth) return auth.error;

    const customerModelGhadaq = getUserModelByAppId('ghadaq');
    const customerModelManasik = getUserModelByAppId('manasik');

    const [
      activeProducts,
      totalOrders,
      totalCustomers,
      tomorrowExecutionCount,
    ] = await Promise.all([
      // Match the public /api/products listing exactly: active products that are not deleted.
      Product.countDocuments({ isActive: true, isDeleted: { $ne: true } }),
      Order.countDocuments(),
      Promise.all([
        customerModelGhadaq.countDocuments(),
        customerModelManasik.countDocuments(),
      ]).then(([ghadaqCount, manasikCount]) => ghadaqCount + manasikCount),
      Order.aggregate([
        { $match: { status: { $in: ['paid', 'partial-paid'] } } },
        {
          $addFields: {
            executionDateValue: {
              $ifNull: [
                {
                  $reduce: {
                    input: { $ifNull: ['$reservationData', []] },
                    initialValue: '',
                    in: {
                      $cond: [
                        { $eq: ['$$this.key', 'executionDate'] },
                        '$$this.value',
                        '$$value',
                      ],
                    },
                  },
                },
                '',
              ],
            },
          },
        },
        {
          $addFields: {
            effectiveExecutionDate: {
              $cond: [
                { $eq: ['$executionDateValue', ''] },
                {
                  $dateToString: {
                    format: '%Y-%m-%d',
                    date: { $add: ['$createdAt', 86400000] },
                    timezone: 'UTC',
                  },
                },
                { $substr: ['$executionDateValue', 0, 10] },
              ],
            },
          },
        },
        { $match: { effectiveExecutionDate: getTomorrowDate() } },
        { $count: 'count' },
      ]).then((result) => result[0]?.count ?? 0),
    ]);

    return NextResponse.json({
      success: true,
      data: {
        activeProducts,
        totalOrders,
        totalCustomers,
        tomorrowExecutionCount,
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
