import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import Coupon from '@/lib/models/Coupon';
import { logActivity } from '@/lib/services/logger';
import { parseJsonBody } from '@/lib/validation/http';
import { couponUpdateSchema } from '@/lib/validation/schemas';

function normalizeCouponPayload<T extends Record<string, unknown>>(body: T): T {
  const normalized: Record<string, unknown> = { ...body };

  if (typeof normalized.code === 'string') {
    normalized.code = normalized.code.trim().toUpperCase();
  }

  if (Array.isArray(normalized.fixedPrices)) {
    normalized.fixedPrices = normalized.fixedPrices
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
  }

  if (Array.isArray(normalized.maxDiscountPrices)) {
    normalized.maxDiscountPrices = normalized.maxDiscountPrices
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
  }

  if (Array.isArray(normalized.allowedCountries)) {
    normalized.allowedCountries = [
      ...new Set(
        normalized.allowedCountries
          .map((code) =>
            String(code || '')
              .trim()
              .toUpperCase(),
          )
          .filter((code) => /^[A-Z]{2}$/.test(code)),
      ),
    ];
  }

  if (normalized.type === 'fixed' || normalized.fixedPrices) {
    const firstFixedPrice = (
      normalized.fixedPrices as Array<{ amount: number }> | undefined
    )?.[0];
    if (firstFixedPrice) {
      normalized.value = Number(firstFixedPrice.amount || 0);
    }
  }

  if (
    (normalized.maxDiscountPrices as Array<{ amount: number }> | undefined)
      ?.length
  ) {
    normalized.maxDiscountAmount = Number(
      (normalized.maxDiscountPrices as Array<{ amount: number }>)[0].amount ||
        0,
    );
  }

  return normalized as T;
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess('coupons');
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
    const auth = await requireAdminPageAccess('coupons');
    if ('error' in auth) return auth.error;

    const { id } = await params;
    const parsed = await parseJsonBody(request, couponUpdateSchema);
    if (!parsed.success) return parsed.response;
    const body = parsed.data;
    const payload = normalizeCouponPayload(body);

    const coupon = await Coupon.findByIdAndUpdate(id, payload, {
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
    const auth = await requireAdminPageAccess('coupons');
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
