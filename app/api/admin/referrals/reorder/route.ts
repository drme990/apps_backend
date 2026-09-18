import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import Referral from '@/lib/models/Referral';
import Setting from '@/lib/models/Setting';
import { logActivity } from '@/lib/services/logger';
import { parseJsonBody } from '@/lib/validation/http';
import {
  DEFAULT_REF_ORDER_KEY,
  getDefaultRefPositions,
} from '../default-order/route';

const DEFAULT_REF_IDS = new Set(['MNK-D', 'GHD-D']);

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

    // Default ref codes (MNK-D / GHD-D) are virtual — they aren't stored
    // as Referral documents, so their positions live in the Setting
    // collection instead.
    const defaultEntries = orders.filter((entry) =>
      DEFAULT_REF_IDS.has(entry.id),
    );
    const realEntries = orders.filter((entry) => !DEFAULT_REF_IDS.has(entry.id));

    if (defaultEntries.length > 0) {
      const positions = await getDefaultRefPositions();
      for (const entry of defaultEntries) {
        positions[entry.id as keyof typeof positions] = entry.filterOrder;
      }
      await Setting.findOneAndUpdate(
        { key: DEFAULT_REF_ORDER_KEY },
        { key: DEFAULT_REF_ORDER_KEY, value: positions },
        { upsert: true },
      );
    }

    let modifiedCount = 0;
    if (realEntries.length > 0) {
      const bulkOps = realEntries.map((entry) => ({
        updateOne: {
          filter: { _id: entry.id },
          update: { $set: { filterOrder: entry.filterOrder } },
        },
      }));
      const result = await Referral.bulkWrite(bulkOps);
      modifiedCount = result.modifiedCount;
    }

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
      data: { modifiedCount },
    });
  } catch (error) {
    console.error('Error reordering referrals:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to reorder referrals' },
      { status: 500 },
    );
  }
}
