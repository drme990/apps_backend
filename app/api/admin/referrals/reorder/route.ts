import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import Referral from '@/lib/models/Referral';
import { logActivity } from '@/lib/services/logger';
import { parseJsonBody } from '@/lib/validation/http';

const reorderSchema = z
  .object({
    orders: z
      .array(
        z.object({
          id: z.string().min(1),
          filterOrder: z.number().int(),
        }),
      )
      .min(1),
  })
  .strict();

/**
 * Bulk update the `filterOrder` of referrals.
 *
 * Body: { orders: [{ id, filterOrder }, ...] }
 *
 * Uses the MongoDB bulkWrite API to update all referrals in one round-trip.
 */
export async function PUT(request: NextRequest) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess('referrals');
    if ('error' in auth) return auth.error;

    const parsed = await parseJsonBody(request, reorderSchema);
    if (!parsed.success) return parsed.response;
    const { orders } = parsed.data;

    const bulkOps = orders.map((entry) => ({
      updateOne: {
        filter: { _id: entry.id },
        update: { $set: { filterOrder: entry.filterOrder } },
      },
    }));

    const result = await Referral.bulkWrite(bulkOps);

    await logActivity({
      userId: auth.user.userId,
      userName: auth.user.name,
      userEmail: auth.user.email,
      action: 'update',
      resource: 'referral',
      resourceId: 'bulk-reorder',
      details: `Reordered ${orders.length} referrals`,
    });

    return NextResponse.json({
      success: true,
      data: { modifiedCount: result.modifiedCount },
    });
  } catch (error) {
    console.error('Error reordering referrals:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to reorder referrals' },
      { status: 500 },
    );
  }
}
