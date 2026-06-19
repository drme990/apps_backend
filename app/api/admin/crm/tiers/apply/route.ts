import { NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import { bulkEvaluateAllUserTiers } from '@/lib/services/user-tier-evaluator';
import { logActivity } from '@/lib/services/logger';

export async function POST() {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess('crm');
    if ('error' in auth) return auth.error;

    const result = await bulkEvaluateAllUserTiers();

    await logActivity({
      userId: auth.user.userId,
      userName: auth.user.name,
      userEmail: auth.user.email,
      action: 'update',
      resource: 'userTier',
      details: `Bulk applied user tiers: ${result.processed} processed, ${result.errors} errors`,
    });

    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    console.error('Error applying tiers:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to apply tiers' },
      { status: 500 },
    );
  }
}
