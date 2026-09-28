import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import {
  listBookingIntents,
  type BookingIntentStatus,
} from '@/lib/services/order-intent';

const VALID_STATUSES = new Set([
  'all',
  'new',
  'contacted',
  'refused',
  'converted',
  'closed',
]);

export async function GET(request: NextRequest) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess('orders');
    if ('error' in auth) return auth.error;

    const { searchParams } = request.nextUrl;

    const rawStatus = (searchParams.get('status') || 'all').toLowerCase();
    const status = (
      VALID_STATUSES.has(rawStatus) ? rawStatus : 'all'
    ) as BookingIntentStatus | 'all';

    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10) || 1);
    const limit = Math.min(
      Math.max(1, parseInt(searchParams.get('limit') || '52', 10) || 52),
      200,
    );

    const result = await listBookingIntents({
      status,
      assignedTo: searchParams.get('assignedTo') || undefined,
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
      page,
      limit,
      adminId: auth.user.userId,
    });

    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    console.error('Error listing booking intents:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to list booking intents' },
      { status: 500 },
    );
  }
}
