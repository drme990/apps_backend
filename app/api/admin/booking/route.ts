import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAuth } from '@/lib/auth';
import Booking from '@/lib/models/Booking';
import { logActivity } from '@/lib/services/logger';
import { parseJsonBody } from '@/lib/validation/http';
import { bookingUpdateSchema } from '@/lib/validation/schemas';

function normalizeBlockedDates(input: unknown): string[] {
  if (!Array.isArray(input)) return [];

  const normalized = input
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value));

  return Array.from(new Set(normalized)).sort();
}

export async function GET() {
  try {
    await connectDB();
    const auth = await requireAuth();
    if ('error' in auth) return auth.error;

    const booking = await Booking.findOne({ key: 'global' }).lean();

    return NextResponse.json({
      success: true,
      data: {
        blockedExecutionDates: booking?.blockedExecutionDates ?? [],
      },
    });
  } catch (error) {
    console.error('Error fetching booking settings:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch booking settings' },
      { status: 500 },
    );
  }
}

export async function PUT(request: NextRequest) {
  try {
    await connectDB();
    const auth = await requireAuth();
    if ('error' in auth) return auth.error;

    const parsed = await parseJsonBody(request, bookingUpdateSchema);
    if (!parsed.success) return parsed.response;
    const body = parsed.data;
    const blockedExecutionDates = normalizeBlockedDates(
      body?.blockedExecutionDates,
    );

    const booking = await Booking.findOneAndUpdate(
      { key: 'global' },
      {
        key: 'global',
        blockedExecutionDates,
      },
      { upsert: true, new: true, runValidators: true },
    );

    await logActivity({
      userId: auth.user.userId,
      userName: auth.user.name,
      userEmail: auth.user.email,
      action: 'update',
      resource: 'booking',
      resourceId: booking._id.toString(),
      details: `Updated blocked execution dates: ${blockedExecutionDates.length} date(s)`,
    });

    return NextResponse.json({
      success: true,
      data: {
        blockedExecutionDates: booking.blockedExecutionDates,
      },
    });
  } catch (error) {
    console.error('Error updating booking settings:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to update booking settings' },
      { status: 500 },
    );
  }
}
