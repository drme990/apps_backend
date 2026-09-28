import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAdminAction, requireAdminPageAccess } from '@/lib/auth';
import { getBookingIntentStats } from '@/lib/services/order-intent';

export async function GET(request: NextRequest) {
  try {
    await connectDB();
    const pageAuth = await requireAdminPageAccess('orders');
    if ('error' in pageAuth) return pageAuth.error;

    // Achievements are an action-level permission — not everyone with
    // orders access can see per-admin performance.
    const auth = await requireAdminAction('achievements');
    if ('error' in auth) return auth.error;

    const { searchParams } = request.nextUrl;
    const stats = await getBookingIntentStats(
      searchParams.get('fromDate') || undefined,
      searchParams.get('toDate') || undefined,
    );

    return NextResponse.json({ success: true, data: stats });
  } catch (error) {
    console.error('Error fetching booking-intent stats:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch stats' },
      { status: 500 },
    );
  }
}
