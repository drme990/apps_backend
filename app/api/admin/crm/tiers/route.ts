import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import UserTier from '@/lib/models/UserTier';
import { logActivity } from '@/lib/services/logger';

const minimumAmountSchema = z.object({
  currencyCode: z.string().trim().min(1).max(10).toUpperCase(),
  amount: z.number().min(0),
  isManual: z.boolean().default(false),
});

const createTierSchema = z.object({
  name: z.string().trim().min(1).max(100),
  color: z.string().trim().min(1).max(50).optional(),
  mainCurrency: z.string().trim().min(1).max(10).toUpperCase(),
  baseAmount: z.number().min(0),
  minimumAmounts: z.array(minimumAmountSchema).default([]),
});

export async function GET() {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess('crm');
    if ('error' in auth) return auth.error;

    const tiers = await UserTier.find().sort({ baseAmount: -1 }).lean();

    return NextResponse.json({ success: true, data: tiers });
  } catch (error) {
    console.error('Error fetching tiers:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch tiers' },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess('crm');
    if ('error' in auth) return auth.error;

    const body = await request.json();
    const parsed = createTierSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: 'Invalid payload', details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const tier = await UserTier.create(parsed.data);

    await logActivity({
      userId: auth.user.userId,
      userName: auth.user.name,
      userEmail: auth.user.email,
      action: 'create',
      resource: 'userTier',
      resourceId: String(tier._id),
      details: `Created user tier: ${tier.name}`,
    });

    return NextResponse.json({ success: true, data: tier }, { status: 201 });
  } catch (error) {
    console.error('Error creating tier:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to create tier' },
      { status: 500 },
    );
  }
}
