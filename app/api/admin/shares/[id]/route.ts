import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import ShareCampaign from '@/lib/models/ShareCampaign';
import Product from '@/lib/models/Product';
import { logActivity } from '@/lib/services/logger';
import { parseJsonBody } from '@/lib/validation/http';
import { shareCampaignUpdateSchema } from '@/lib/validation/schemas';
import { incrementShareCampaignSold } from '@/lib/services/share-campaign';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess('orders');
    if ('error' in auth) return auth.error;

    const { id } = await params;
    const campaign = await ShareCampaign.findById(id).lean();
    if (!campaign) {
      return NextResponse.json(
        { success: false, error: 'Campaign not found' },
        { status: 404 },
      );
    }

    const product = await Product.findById(campaign.productId, {
      name: 1,
      slug: 1,
      sizes: 1,
      baseCurrency: 1,
    }).lean();

    return NextResponse.json({
      success: true,
      data: {
        ...campaign,
        _id: String(campaign._id),
        productId: String(campaign.productId),
        productName: product?.name || null,
        productSlug: product?.slug || null,
        productSizes: product?.sizes?.map((s, i) => ({
          sizeIndex: i,
          name: s.name,
          basePrice: s.basePrice,
        })) || [],
        baseCurrency: product?.baseCurrency || null,
      },
    });
  } catch (error) {
    console.error('Error fetching share campaign:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch share campaign' },
      { status: 500 },
    );
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess('orders');
    if ('error' in auth) return auth.error;

    const { id } = await params;
    const parsed = await parseJsonBody(request, shareCampaignUpdateSchema);
    if (!parsed.success) return parsed.response;
    const {
      status,
      totalShares,
      campaignNumber,
      displayOnProductPage,
      minDisplayPercent,
      addSoldShares,
    } = parsed.data;

    const campaign = await ShareCampaign.findById(id);
    if (!campaign) {
      return NextResponse.json(
        { success: false, error: 'Campaign not found' },
        { status: 404 },
      );
    }

    // Cannot change totalShares after shares have been sold
    if (totalShares !== undefined && campaign.soldShares > 0) {
      return NextResponse.json(
        {
          success: false,
          error: 'Cannot change total shares after shares have been sold',
        },
        { status: 400 },
      );
    }

    // Cannot change status of a completed campaign
    if (status !== undefined && campaign.status === 'completed') {
      return NextResponse.json(
        {
          success: false,
          error: 'Cannot change status of a completed campaign',
        },
        { status: 400 },
      );
    }

    // Reject a campaign code that already exists on this product
    if (
      campaignNumber !== undefined &&
      campaignNumber !== campaign.campaignNumber
    ) {
      const conflict = await ShareCampaign.findOne({
        productId: campaign.productId,
        campaignNumber,
        _id: { $ne: campaign._id },
      }).lean();
      if (conflict) {
        return NextResponse.json(
          {
            success: false,
            error: 'A campaign with this code already exists for this product',
          },
          { status: 400 },
        );
      }
      campaign.campaignNumber = campaignNumber;
    }

    if (status !== undefined) campaign.status = status;
    if (totalShares !== undefined) campaign.totalShares = totalShares;
    if (displayOnProductPage !== undefined) {
      campaign.displayOnProductPage = displayOnProductPage;
    }
    if (minDisplayPercent !== undefined) {
      campaign.minDisplayPercent = minDisplayPercent;
    }

    await campaign.save();

    // Manually reserved shares go through the same increment logic as
    // orders — so overflow creates a new campaign and a full count
    // completes this one. Runs after save() so the stale in-memory
    // soldShares can't clobber the increment.
    if (addSoldShares !== undefined && addSoldShares > 0) {
      await incrementShareCampaignSold(campaign._id, addSoldShares);
    }

    await logActivity({
      userId: auth.user.userId,
      userName: auth.user.name,
      userEmail: auth.user.email,
      action: 'update',
      resource: 'shareCampaign',
      resourceId: String(campaign._id),
      details: `Updated share campaign #${campaign.campaignNumber}`,
    });

    // Re-fetch so the response reflects the increment (status may have
    // changed to 'completed', or soldShares may live on a new campaign).
    const updated = await ShareCampaign.findById(campaign._id).lean();
    return NextResponse.json({ success: true, data: updated });
  } catch (error) {
    console.error('Error updating share campaign:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to update share campaign' },
      { status: 500 },
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess('orders');
    if ('error' in auth) return auth.error;

    const { id } = await params;
    const campaign = await ShareCampaign.findById(id);
    if (!campaign) {
      return NextResponse.json(
        { success: false, error: 'Campaign not found' },
        { status: 404 },
      );
    }

    if (campaign.soldShares > 0) {
      return NextResponse.json(
        {
          success: false,
          error: 'Cannot delete a campaign with sold shares',
        },
        { status: 400 },
      );
    }

    await ShareCampaign.findByIdAndDelete(id);

    await logActivity({
      userId: auth.user.userId,
      userName: auth.user.name,
      userEmail: auth.user.email,
      action: 'delete',
      resource: 'shareCampaign',
      resourceId: id,
      details: `Deleted share campaign #${campaign.campaignNumber}`,
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error deleting share campaign:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to delete share campaign' },
      { status: 500 },
    );
  }
}
