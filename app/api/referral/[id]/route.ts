import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import Referral from '@/lib/models/Referral';

const DEFAULT_REFS = new Set(['MNK-D', 'GHD-D']);

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

    // Default ref codes are not stored in the DB — return a 404 with
    // a clear message so the frontend can fall back to the default phone.
    if (DEFAULT_REFS.has(id)) {
      return NextResponse.json(
        { success: false, error: 'Default referral — use default phone' },
        { status: 404 },
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
