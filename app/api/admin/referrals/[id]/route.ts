import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAuth } from '@/lib/auth';
import Referral from '@/lib/models/Referral';
import { logActivity } from '@/lib/services/logger';
import { parseJsonBody } from '@/lib/validation/http';
import { referralUpdateSchema } from '@/lib/validation/schemas';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await connectDB();
    const auth = await requireAuth();
    if ('error' in auth) return auth.error;

    const { id } = await params;
    const referral = await Referral.findById(id).lean();
    if (!referral) {
      return NextResponse.json(
        { success: false, error: 'Referral not found' },
        { status: 404 },
      );
    }
    return NextResponse.json({ success: true, data: referral });
  } catch (error) {
    console.error('Error fetching referral:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch referral' },
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
    const parsed = await parseJsonBody(request, referralUpdateSchema);
    if (!parsed.success) return parsed.response;
    const body = parsed.data;
    const referral = await Referral.findByIdAndUpdate(id, body, {
      new: true,
      runValidators: true,
    });
    if (!referral) {
      return NextResponse.json(
        { success: false, error: 'Referral not found' },
        { status: 404 },
      );
    }

    await logActivity({
      userId: auth.user.userId,
      userName: auth.user.name,
      userEmail: auth.user.email,
      action: 'update',
      resource: 'referral',
      resourceId: referral._id.toString(),
      details: `Updated referral: ${referral.name} (${referral.referralId})`,
    });

    return NextResponse.json({ success: true, data: referral });
  } catch (error) {
    console.error('Error updating referral:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to update referral' },
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
    const referral = await Referral.findByIdAndDelete(id);
    if (!referral) {
      return NextResponse.json(
        { success: false, error: 'Referral not found' },
        { status: 404 },
      );
    }

    await logActivity({
      userId: auth.user.userId,
      userName: auth.user.name,
      userEmail: auth.user.email,
      action: 'delete',
      resource: 'referral',
      resourceId: id,
      details: `Deleted referral: ${referral.name} (${referral.referralId})`,
    });

    return NextResponse.json({
      success: true,
      message: 'Referral deleted successfully',
    });
  } catch (error) {
    console.error('Error deleting referral:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to delete referral' },
      { status: 500 },
    );
  }
}
