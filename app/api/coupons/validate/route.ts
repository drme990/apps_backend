import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { getAuthUser } from '@/lib/auth';
import { getUserModelByAppId } from '@/lib/auth/app-users';
import { validateCoupon } from '@/lib/services/coupon';
import { normalizeCurrencyCode } from '@/lib/currencies';
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
    const { code, orderAmount, currency: rawCurrency, productId } = parsed.data;

    // Normalize currency to ISO 4217 code (handles localized symbols like "ج.م" → "EGP")
    const currency = normalizeCurrencyCode(rawCurrency);

    let detectedCountry: string | null = null;
    const authUser =
      (await getAuthUser('ghadaq')) || (await getAuthUser('manasik'));
    if (
      authUser &&
      (authUser.appId === 'ghadaq' || authUser.appId === 'manasik')
    ) {
      const UserModel = getUserModelByAppId(authUser.appId);
      const typedUserModel = UserModel as unknown as {
        findById(id: string): {
          select(fields: string): {
            lean(): Promise<{ detectedCountry?: string | null } | null>;
          };
        };
      };
      const user = await typedUserModel
        .findById(authUser.userId)
        .select('detectedCountry')
        .lean();
      detectedCountry =
        user && typeof user.detectedCountry === 'string'
          ? user.detectedCountry
          : null;
    }

    const result = await validateCoupon(
      code,
      orderAmount,
      currency,
      productId,
      detectedCountry,
    );

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
