import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAuth } from '@/lib/auth';
import { validateCoupon } from '@/lib/services/coupon';

export async function POST(request: NextRequest) {
  try {
    await connectDB();
    const auth = await requireAuth();
    if ('error' in auth) return auth.error;

    const { code, orderAmount, currency, productId } = await request.json();

    if (!code || !orderAmount || !currency) {
      return NextResponse.json(
        { success: false, error: 'Missing required fields' },
        { status: 400 },
      );
    }

    const result = await validateCoupon(code, orderAmount, currency, productId);

    if (!result.valid) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: 400 },
      );
    }

    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    console.error('Error validating coupon:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to validate coupon' },
      { status: 500 },
    );
  }
}
