import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import ShareCampaign from '@/lib/models/ShareCampaign';
import Order from '@/lib/models/Order';

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

    const totalPages = Math.ceil(total / maxLimit);
    return NextResponse.json({
      success: true,
      data: { orders, pagination: { totalPages, total } },
    });
  } catch (error) {
    console.error('Error fetching campaign orders:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch campaign orders' },
      { status: 500 },
    );
  }
}
