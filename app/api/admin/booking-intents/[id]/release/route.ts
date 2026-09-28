import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import { releaseCustomer } from '@/lib/services/order-intent';
import { logActivity } from '@/lib/services/logger';
import mongoose from 'mongoose';

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess('orders');
    if ('error' in auth) return auth.error;

    const { id } = await params;
    if (!mongoose.isValidObjectId(id)) {
      return NextResponse.json(
        { success: false, error: 'Invalid intent id' },
        { status: 400 },
      );
    }

    const result = await releaseCustomer(
      {
        adminId: auth.user.userId,
        name: auth.user.name ?? auth.user.email,
        email: auth.user.email,
      },
      id,
    );

    if (!result.ok) {
      const status =
        result.reason === 'not_found'
          ? 404
          : result.reason === 'not_owner'
            ? 403
            : 400;
      return NextResponse.json(
        { success: false, error: `Cannot release: ${result.reason}` },
        { status },
      );
    }

    await logActivity({
      userId: auth.user.userId,
      userName: auth.user.name,
      userEmail: auth.user.email,
      action: 'update',
      resource: 'bookingIntent',
      resourceId: id,
      details: `Released booking-intent customer (${result.releasedCount} intents)`,
    });

    return NextResponse.json({
      success: true,
      data: { releasedCount: result.releasedCount },
    });
  } catch (error) {
    console.error('Error releasing booking intent:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to release booking intent' },
      { status: 500 },
    );
  }
}
