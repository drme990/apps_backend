import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAdminAction, requireAdminPageAccess } from '@/lib/auth';
import {
  getAdminAchievements,
  type BookingIntentStatus,
} from '@/lib/services/order-intent';
import mongoose from 'mongoose';

const VALID_STATUSES = new Set(['all', 'new', 'contacted', 'converted']);

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await connectDB();
    // Opened from the booking-intent achievements stats — gate on the
    // same orders page access as the list, not the admins page.
    const pageAuth = await requireAdminPageAccess('orders');
    if ('error' in pageAuth) return pageAuth.error;

    // Per-admin performance data — same action permission as the
    // booking-intent stats endpoint.
    const auth = await requireAdminAction('achievements');
    if ('error' in auth) return auth.error;

    const { id } = await params;
    if (!mongoose.isValidObjectId(id)) {
      return NextResponse.json(
        { success: false, error: 'Invalid user id' },
        { status: 400 },
      );
    }

    // Same filters as the booking-intent list/stats — the modal shows
    // exactly the displayed rows this admin owns.
    const { searchParams } = request.nextUrl;
    const rawStatus = (searchParams.get('status') || 'all').toLowerCase();
    const status = (
      VALID_STATUSES.has(rawStatus) ? rawStatus : 'all'
    ) as BookingIntentStatus | 'all';

    const data = await getAdminAchievements(id, {
      status,
      source:
        searchParams.get('source') === 'ghadaq' ||
          searchParams.get('source') === 'manasik'
          ? (searchParams.get('source') as 'manasik' | 'ghadaq')
          : undefined,
      search: searchParams.get('search')?.trim() || undefined,
      fromDate: searchParams.get('fromDate') || undefined,
      toDate: searchParams.get('toDate') || undefined,
      category: searchParams.get('category') || undefined,
      country: searchParams.get('country') || undefined,
      intention: searchParams.get('intention') || undefined,
      referralId: searchParams.get('referralId') || undefined,
    });
    return NextResponse.json({ success: true, data });
  } catch (error) {
    console.error('Error fetching admin achievements:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch admin achievements' },
      { status: 500 },
    );
  }
}
