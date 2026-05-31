import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import Coupon from '@/lib/models/Coupon';
import { logActivity } from '@/lib/services/logger';
import { parseJsonBody } from '@/lib/validation/http';
import { couponCreateSchema } from '@/lib/validation/schemas';

function normalizeCouponPayload<T extends Record<string, unknown>>(body: T): T {
  const normalized: Record<string, unknown> = { ...body };

  if (typeof normalized.code === 'string') {
    normalized.code = normalized.code.trim().toUpperCase();
  }

  const fixedPrices = Array.isArray(normalized.fixedPrices)
    ? normalized.fixedPrices
    : [];
  normalized.fixedPrices = fixedPrices
    .filter((item) => item && typeof item === 'object')
    .map((item) => {
      const entry = item as { currencyCode?: unknown; amount?: unknown };
      return {
        currencyCode: String(entry.currencyCode || '')
          .trim()
          .toUpperCase(),
        amount: Number(entry.amount || 0),
      };
    })
    .filter((item) => item.currencyCode && item.amount >= 0);

  const maxDiscountPrices = Array.isArray(normalized.maxDiscountPrices)
    ? normalized.maxDiscountPrices
    : [];
  normalized.maxDiscountPrices = maxDiscountPrices
    .filter((item) => item && typeof item === 'object')
    .map((item) => {
      const entry = item as { currencyCode?: unknown; amount?: unknown };
      return {
        currencyCode: String(entry.currencyCode || '')
          .trim()
          .toUpperCase(),
        amount: Number(entry.amount || 0),
      };
    })
    .filter((item) => item.currencyCode && item.amount >= 0);

  const allowedCountries = Array.isArray(normalized.allowedCountries)
    ? normalized.allowedCountries
    : [];
  normalized.allowedCountries = [
    ...new Set(
      allowedCountries
        .map((code) =>
          String(code || '')
            .trim()
            .toUpperCase(),
        )
        .filter((code) => /^[A-Z]{2}$/.test(code)),
    ),
  ];

  if (normalized.type === 'fixed') {
    const firstFixedPrice = (
      normalized.fixedPrices as Array<{ amount: number }>
    )[0];
    normalized.value = Number(firstFixedPrice?.amount || 0);
  }

  if ((normalized.maxDiscountPrices as Array<{ amount: number }>).length) {
    normalized.maxDiscountAmount = Number(
      (normalized.maxDiscountPrices as Array<{ amount: number }>)[0].amount ||
        0,
    );
  }

  return normalized as T;
}

export async function GET(request: NextRequest) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess('coupons');
    if ('error' in auth) return auth.error;

    const { searchParams } = request.nextUrl;
    const page = parseInt(searchParams.get('page') || '1');
    const limit = parseInt(searchParams.get('limit') || '50');
    // Enforce MAX_LIMIT
    const maxLimit = limit > 100 ? 100 : limit;
    const skip = (page - 1) * maxLimit;

    const [coupons, total] = await Promise.all([
      Coupon.find().sort({ createdAt: -1 }).skip(skip).limit(maxLimit).lean(),
      Coupon.countDocuments(),
    ]);

    const totalPages = Math.ceil(total / maxLimit);

    return NextResponse.json({
      success: true,
      data: {
        coupons,
        pagination: {
          currentPage: page,
          totalPages,
          totalItems: total,
          hasNextPage: page < totalPages,
          hasPrevPage: page > 1,
        },
      },
    });
  } catch (error) {
    console.error('Error fetching coupons:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch coupons' },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess('coupons');
    if ('error' in auth) return auth.error;

    const parsed = await parseJsonBody(request, couponCreateSchema);
    if (!parsed.success) return parsed.response;
    const body = parsed.data;

    const existing = await Coupon.findOne({
      code: body.code?.toUpperCase().trim(),
    });
    if (existing) {
      return NextResponse.json(
        { success: false, error: 'Coupon code already exists' },
        { status: 400 },
      );
    }

    const payload = normalizeCouponPayload(body);

    const coupon = await Coupon.create({
      ...payload,
      createdBy: auth.user.userId,
    });

    await logActivity({
      userId: auth.user.userId,
      userName: auth.user.name,
      userEmail: auth.user.email,
      action: 'create',
      resource: 'coupon',
      resourceId: coupon._id.toString(),
      details: `Created coupon: ${coupon.code} (${coupon.type})`,
    });

    return NextResponse.json({ success: true, data: coupon }, { status: 201 });
  } catch (error) {
    console.error('Error creating coupon:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to create coupon' },
      { status: 500 },
    );
  }
}
