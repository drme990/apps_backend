import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { validateCoupon } from '@/lib/services/coupon';
import { rateLimit, getClientIp } from '@/lib/rate-limit';
import { parseJsonBody } from '@/lib/validation/http';
import { couponValidationSchema } from '@/lib/validation/schemas';

export async function POST(request: NextRequest) {
  try {
    // Rate limit: 20 coupon attempts per IP per minute
    const ip = getClientIp(request);
    const rl = rateLimit(`coupon:${ip}`, 20, 60_000);
    if (!rl.allowed) {
      return NextResponse.json(
        { success: false, error: 'Too many requests. Please try again later.' },
        { status: 429 },
      );
    }

    await connectDB();
    const parsed = await parseJsonBody(request, couponValidationSchema);
    if (!parsed.success) return parsed.response;
    const { code, orderAmount, currency, productId } = parsed.data;

    const result = await validateCoupon(code, orderAmount, currency, productId);

    if (!result.valid) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: 400 },
      );
    }

    return NextResponse.json({
      success: true,
      data: {
        code: result.coupon?.code,
        type: result.coupon?.type,
        value: result.coupon?.value,
        discountAmount: result.discountAmount,
        description: result.coupon?.description,
      },
    });
  } catch (error) {
    console.error('Error validating coupon:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to validate coupon' },
      { status: 500 },
    );
  }
}
