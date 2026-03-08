import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import Referral from '@/lib/models/Referral';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    if (!id) {
      return NextResponse.json(
        { success: false, error: 'Referral ID is required' },
        { status: 400 },
      );
    }

    await connectDB();
    const referral = await Referral.findOne({ referralId: id }).select(
      'phone name',
    );

    if (!referral) {
      return NextResponse.json(
        { success: false, error: 'Referral not found' },
        { status: 404 },
      );
    }

    return NextResponse.json({
      success: true,
      data: { phone: referral.phone, name: referral.name },
    });
  } catch {
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 },
    );
  }
}
