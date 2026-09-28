import { NextRequest, NextResponse } from 'next/server';
import mongoose from 'mongoose';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import ShareCampaignHistory from '@/lib/models/ShareCampaignHistory';

/**
 * GET /api/admin/shares/history[?campaignId=<id>][?productId=<id>]
 *
 * Returns the change history across all share campaigns, newest first.
 * Optional filters scope it to a single campaign or all campaigns of a
 * product (covers deleted and auto-created campaigns that no longer
 * have a card in the UI).
 */
export async function GET(request: NextRequest) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess('orders');
    if ('error' in auth) return auth.error;

    const campaignId = request.nextUrl.searchParams.get('campaignId');
    const productId = request.nextUrl.searchParams.get('productId');

    const filter: Record<string, unknown> = {};
    if (campaignId && mongoose.Types.ObjectId.isValid(campaignId)) {
      filter.campaignId = new mongoose.Types.ObjectId(campaignId);
    }
    if (productId && mongoose.Types.ObjectId.isValid(productId)) {
      filter.productId = new mongoose.Types.ObjectId(productId);
    }

    const history = await ShareCampaignHistory.find(filter)
      .sort({ createdAt: -1 })
      .limit(500)
      .lean();

    const mapped = history.map((entry) => ({
      _id: String(entry._id),
      campaignId: String(entry.campaignId),
      campaignNumber: entry.campaignNumber,
      productName: entry.productName || null,
      changeType: entry.changeType,
      previousValue: entry.previousValue,
      newValue: entry.newValue,
      details: entry.details || '',
      changedByUserName: entry.changedByUserName,
      changedByUserEmail: entry.changedByUserEmail,
      createdAt: entry.createdAt,
    }));

    return NextResponse.json({ success: true, data: mapped });
  } catch (error) {
    console.error('Error fetching share campaign history:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch campaign history' },
      { status: 500 },
    );
  }
}
