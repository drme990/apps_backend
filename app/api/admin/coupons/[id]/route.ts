import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAuth } from '@/lib/auth';
import Coupon from '@/lib/models/Coupon';
import { logActivity } from '@/lib/services/logger';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await connectDB();
    const auth = await requireAuth();
    if ('error' in auth) return auth.error;

    const { id } = await params;
    const coupon = await Coupon.findById(id).lean();
    if (!coupon) {
      return NextResponse.json(
        { success: false, error: 'Coupon not found' },
        { status: 404 },
      );
    }
    return NextResponse.json({ success: true, data: coupon });
  } catch (error) {
    console.error('Error fetching coupon:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch coupon' },
      { status: 500 },
    );
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await connectDB();
    const auth = await requireAuth();
    if ('error' in auth) return auth.error;

    const { id } = await params;
    const body = await request.json();
    const coupon = await Coupon.findByIdAndUpdate(id, body, {
      new: true,
      runValidators: true,
    });
    if (!coupon) {
      return NextResponse.json(
        { success: false, error: 'Coupon not found' },
        { status: 404 },
      );
    }

    await logActivity({
      userId: auth.user.userId,
      userName: auth.user.name,
      userEmail: auth.user.email,
      action: 'update',
      resource: 'coupon',
      resourceId: coupon._id.toString(),
      details: `Updated coupon: ${coupon.code}`,
    });

    return NextResponse.json({ success: true, data: coupon });
  } catch (error) {
    console.error('Error updating coupon:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to update coupon' },
      { status: 500 },
    );
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await connectDB();
    const auth = await requireAuth();
    if ('error' in auth) return auth.error;

    const { id } = await params;
    const coupon = await Coupon.findByIdAndDelete(id);
    if (!coupon) {
      return NextResponse.json(
        { success: false, error: 'Coupon not found' },
        { status: 404 },
      );
    }

    await logActivity({
      userId: auth.user.userId,
      userName: auth.user.name,
      userEmail: auth.user.email,
      action: 'delete',
      resource: 'coupon',
      resourceId: id,
      details: `Deleted coupon: ${coupon.code}`,
    });

    return NextResponse.json({
      success: true,
      message: 'Coupon deleted successfully',
    });
  } catch (error) {
    console.error('Error deleting coupon:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to delete coupon' },
      { status: 500 },
    );
  }
}
