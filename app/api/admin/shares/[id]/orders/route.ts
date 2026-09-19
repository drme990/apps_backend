import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import ShareCampaign from '@/lib/models/ShareCampaign';
import Order from '@/lib/models/Order';
import { getUserModelByAppId, type AppId } from '@/lib/auth/app-users';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess('orders');
    if ('error' in auth) return auth.error;

    const { id } = await params;
    const campaign = await ShareCampaign.findById(id).lean();
    if (!campaign) {
      return NextResponse.json(
        { success: false, error: 'Campaign not found' },
        { status: 404 },
      );
    }

    const page = parseInt(request.nextUrl.searchParams.get('page') || '1');
    const limit = parseInt(request.nextUrl.searchParams.get('limit') || '50');
    const maxLimit = Math.min(limit, 200);
    const skip = (page - 1) * maxLimit;

    const filter = {
      'items.shareCampaignId': campaign._id,
      status: { $in: ['paid', 'partial-paid', 'completed'] },
    };

    const [orders, total] = await Promise.all([
      Order.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(maxLimit)
        .lean(),
      Order.countDocuments(filter),
    ]);

    // Attach each user's detectedCountry — Order.userId is a
    // polymorphic ref, so group userIds by order.source and query
    // each user collection once.
    const userIdsBySource = new Map<string, Set<string>>();
    for (const order of orders) {
      if (order.userId && order.source) {
        const set = userIdsBySource.get(order.source) || new Set<string>();
        set.add(String(order.userId));
        userIdsBySource.set(order.source, set);
      }
    }

    const detectedByUser = new Map<string, string>();
    await Promise.all(
      [...userIdsBySource].map(async ([source, ids]) => {
        try {
          const UserModel = getUserModelByAppId(
            source as AppId,
          ) as unknown as {
            find(filter: unknown): {
              select(fields: string): {
                lean(): Promise<
                  Array<{ _id: unknown; detectedCountry?: string }>
                >;
              };
            };
          };
          const users = await UserModel.find({
            _id: { $in: [...ids] },
          })
            .select('detectedCountry')
            .lean();
          for (const u of users) {
            if (u.detectedCountry) {
              detectedByUser.set(String(u._id), u.detectedCountry);
            }
          }
        } catch {
          // non-fatal — orders just show no detected country
        }
      }),
    );

    const enrichedOrders = orders.map((order) => ({
      ...order,
      detectedCountry:
        (order.userId && detectedByUser.get(String(order.userId))) || null,
    }));

    const totalPages = Math.ceil(total / maxLimit);
    return NextResponse.json({
      success: true,
      data: {
        orders: enrichedOrders,
        manualEntries: campaign.manualShareEntries || [],
        pagination: { totalPages, total },
      },
    });
  } catch (error) {
    console.error('Error fetching campaign orders:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch campaign orders' },
      { status: 500 },
    );
  }
}
