import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import { reopenIntent } from '@/lib/services/order-intent';
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

    const result = await reopenIntent(
      {
        adminId: auth.user.userId,
        name: auth.user.name ?? auth.user.email,
        email: auth.user.email,
      },
      id,
    );

    if (!result.ok) {
      if (result.reason === 'not_found') {
        return NextResponse.json(
          { success: false, error: 'Intent not found' },
          { status: 404 },
        );
      }
      if (result.reason === 'conflict') {
        return NextResponse.json(
          {
            success: false,
            error: 'Customer already claimed',
            claimedBy: result.claimedBy,
          },
          { status: 409 },
        );
      }
      return NextResponse.json(
        { success: false, error: `Cannot reopen: ${result.reason}` },
        { status: 400 },
      );
    }

    await logActivity({
      userId: auth.user.userId,
      userName: auth.user.name,
      userEmail: auth.user.email,
      action: 'update',
      resource: 'bookingIntent',
      resourceId: id,
      details: 'Reopened booking intent',
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error reopening booking intent:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to reopen booking intent' },
      { status: 500 },
    );
  }
}
