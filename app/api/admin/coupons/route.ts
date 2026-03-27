import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import Coupon from '@/lib/models/Coupon';
import { logActivity } from '@/lib/services/logger';
import { parseJsonBody } from '@/lib/validation/http';
import { couponCreateSchema } from '@/lib/validation/schemas';

export async function GET() {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess('coupons');
    if ('error' in auth) return auth.error;

    const coupons = await Coupon.find().sort({ createdAt: -1 }).lean();
    return NextResponse.json({ success: true, data: { coupons } });
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

    const coupon = await Coupon.create({
      ...body,
      createdBy: auth.user.userId,
    });

    await logActivity({
      userId: auth.user.userId,
      userName: auth.user.name,
      userEmail: auth.user.email,
      action: 'create',
      resource: 'coupon',
      resourceId: coupon._id.toString(),
      details: `Created coupon: ${coupon.code} (${coupon.type}: ${coupon.value})`,
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
