import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import RefTrackerEvent from '@/lib/models/RefTrackerEvent';

export async function GET(request: NextRequest) {
  try {
    await connectDB();

    const auth = await requireAdminPageAccess('refTracker');
    if ('error' in auth) return auth.error;

    const page = parseInt(request.nextUrl.searchParams.get('page') || '1', 10);
    const limit = parseInt(
      request.nextUrl.searchParams.get('limit') || '100',
      10,
    );
    const maxLimit = limit > 200 ? 200 : limit;
    const skip = (page - 1) * maxLimit;

    const query: Record<string, unknown> = {};
    const appId = request.nextUrl.searchParams.get('appId');
    const action = request.nextUrl.searchParams.get('action');
    const sessionNumber = request.nextUrl.searchParams.get('sessionNumber');
    const userId = request.nextUrl.searchParams.get('userId');
    const ref = request.nextUrl.searchParams.get('ref');
    const productName = request.nextUrl.searchParams.get('productName');

    if (appId) query.appId = appId;
    if (action) query.action = action;
    if (sessionNumber) query.sessionNumber = sessionNumber;
    if (userId) query.userId = userId;
    if (ref) query.ref = new RegExp(ref, 'i');
    if (productName) query.productName = new RegExp(productName, 'i');

    const [events, total] = await Promise.all([
      RefTrackerEvent.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(maxLimit)
        .lean(),
      RefTrackerEvent.countDocuments(query),
    ]);

    return NextResponse.json({
      success: true,
      data: {
        events,
        pagination: {
          page,
          limit: maxLimit,
          total,
          totalPages: Math.max(1, Math.ceil(total / maxLimit)),
        },
      },
    });
  } catch (error) {
    console.error('Error fetching ref tracker events:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch tracker events' },
      { status: 500 },
    );
  }
}
