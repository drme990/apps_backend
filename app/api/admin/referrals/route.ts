import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAuth } from '@/lib/auth';
import Referral from '@/lib/models/Referral';
import { logActivity } from '@/lib/services/logger';
import { parseJsonBody } from '@/lib/validation/http';
import { referralCreateSchema } from '@/lib/validation/schemas';

export async function GET(request: NextRequest) {
  try {
    await connectDB();
    const auth = await requireAuth();
    if ('error' in auth) return auth.error;

    const page = parseInt(request.nextUrl.searchParams.get('page') || '1');
    const limit = parseInt(request.nextUrl.searchParams.get('limit') || '100');
    const skip = (page - 1) * limit;

    const [referrals, total] = await Promise.all([
      Referral.find().sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Referral.countDocuments(),
    ]);

    const totalPages = Math.ceil(total / limit);
    return NextResponse.json({
      success: true,
      data: { referrals, pagination: { totalPages } },
    });
  } catch (error) {
    console.error('Error fetching referrals:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch referrals' },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    await connectDB();
    const auth = await requireAuth();
    if ('error' in auth) return auth.error;

    const parsed = await parseJsonBody(request, referralCreateSchema);
    if (!parsed.success) return parsed.response;
    const { name, referralId, phone } = parsed.data;

    const existing = await Referral.findOne({ referralId });
    if (existing) {
      return NextResponse.json(
        { success: false, error: 'Referral ID already exists' },
        { status: 400 },
      );
    }

    const referral = await Referral.create({ name, referralId, phone });

    await logActivity({
      userId: auth.user.userId,
      userName: auth.user.name,
      userEmail: auth.user.email,
      action: 'create',
      resource: 'referral',
      resourceId: referral._id.toString(),
      details: `Created referral: ${referral.name} (${referral.referralId})`,
    });

    return NextResponse.json(
      { success: true, data: referral },
      { status: 201 },
    );
  } catch (error) {
    console.error('Error creating referral:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to create referral' },
      { status: 500 },
    );
  }
}
