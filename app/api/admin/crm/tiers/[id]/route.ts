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

const updateTierSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  color: z.string().trim().min(1).max(50).optional(),
  mainCurrency: z.string().trim().min(1).max(10).toUpperCase().optional(),
  baseAmount: z.number().min(0).optional(),
  minimumAmounts: z.array(minimumAmountSchema).optional(),
});

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess('crm');
    if ('error' in auth) return auth.error;

    const { id } = await params;
    const body = await request.json();
    const parsed = updateTierSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: 'Invalid payload', details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const tier = await UserTier.findByIdAndUpdate(id, parsed.data, {
      new: true,
      runValidators: true,
    });

    if (!tier) {
      return NextResponse.json(
        { success: false, error: 'Tier not found' },
        { status: 404 },
      );
    }

    await logActivity({
      userId: auth.user.userId,
      userName: auth.user.name,
      userEmail: auth.user.email,
      action: 'update',
      resource: 'userTier',
      resourceId: id,
      details: `Updated user tier: ${tier.name}`,
    });

    return NextResponse.json({ success: true, data: tier });
  } catch (error) {
    console.error('Error updating tier:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to update tier' },
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
    const auth = await requireAdminPageAccess('crm');
    if ('error' in auth) return auth.error;

    const { id } = await params;
    const tier = await UserTier.findByIdAndDelete(id);

    if (!tier) {
      return NextResponse.json(
        { success: false, error: 'Tier not found' },
        { status: 404 },
      );
    }

    await logActivity({
      userId: auth.user.userId,
      userName: auth.user.name,
      userEmail: auth.user.email,
      action: 'delete',
      resource: 'userTier',
      resourceId: id,
      details: `Deleted user tier: ${tier.name}`,
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error deleting tier:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to delete tier' },
      { status: 500 },
    );
  }
}
