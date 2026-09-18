import { NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import Setting from '@/lib/models/Setting';

export const DEFAULT_REF_ORDER_KEY = 'defaultRefFilterOrder';

export type DefaultRefPositions = { 'MNK-D': number; 'GHD-D': number };

const FALLBACK_POSITIONS: DefaultRefPositions = { 'MNK-D': 0, 'GHD-D': 1 };

export async function getDefaultRefPositions(): Promise<DefaultRefPositions> {
  const doc = await Setting.findOne({ key: DEFAULT_REF_ORDER_KEY }).lean();
  const value = (doc?.value || {}) as Partial<DefaultRefPositions>;
  return {
    'MNK-D':
      typeof value['MNK-D'] === 'number'
        ? value['MNK-D']
        : FALLBACK_POSITIONS['MNK-D'],
    'GHD-D':
      typeof value['GHD-D'] === 'number'
        ? value['GHD-D']
        : FALLBACK_POSITIONS['GHD-D'],
  };
}

/**
 * GET /api/admin/referrals/default-order
 *
 * Returns the filter positions of the virtual default referral codes
 * (MNK-D / GHD-D) so the shared referral filter and the reorder modal
 * can place them among the real referrals.
 */
export async function GET() {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess([
      'referrals',
      'customers',
      'orders',
      'invoices',
      'orderDesigns',
    ]);
    if ('error' in auth) return auth.error;

    const positions = await getDefaultRefPositions();
    return NextResponse.json({ success: true, data: { positions } });
  } catch (error) {
    console.error('Error fetching default ref order:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch default referral order' },
      { status: 500 },
    );
  }
}
