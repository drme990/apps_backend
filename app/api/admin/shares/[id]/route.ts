import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import ShareCampaign from '@/lib/models/ShareCampaign';
import Product from '@/lib/models/Product';
import { logActivity } from '@/lib/services/logger';
import { parseJsonBody } from '@/lib/validation/http';
import { shareCampaignUpdateSchema } from '@/lib/validation/schemas';
import { addReservedShares } from '@/lib/services/share-campaign';

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
    if (displayOnProductPage !== undefined) {
      campaign.displayOnProductPage = displayOnProductPage;
    }
    if (minDisplayPercent !== undefined) {
      campaign.minDisplayPercent = minDisplayPercent;
    }

    await campaign.save();

    // totalShares applies to EVERY active campaign for this product —
    // it affects the current campaigns now, and the next campaigns
    // inherit it automatically (auto-created campaigns copy
    // totalShares from the campaign they were created from).
    if (totalShares !== undefined) {
      await ShareCampaign.updateMany(
        { productId: campaign.productId, status: 'active' },
        { totalShares },
      );

      // Any active campaign now at/over its total completes.
      const overflowed = await ShareCampaign.find({
        productId: campaign.productId,
        status: 'active',
        $expr: { $gte: ['$soldShares', '$totalShares'] },
      }).lean();

      if (overflowed.length > 0) {
        await ShareCampaign.updateMany(
          { _id: { $in: overflowed.map((c) => c._id) } },
          { status: 'completed', completedAt: new Date() },
        );

        // If nothing is left active, spin up the next campaign so the
        // product always has a live one.
        const remaining = await ShareCampaign.countDocuments({
          productId: campaign.productId,
          status: 'active',
        });
        if (remaining === 0) {
          const template = overflowed[0];
          const highest = await ShareCampaign.findOne(
            { productId: campaign.productId },
            { campaignNumber: 1 },
          )
            .sort({ campaignNumber: -1 })
            .lean();
          await ShareCampaign.create({
            productId: campaign.productId,
            totalShares,
            soldShares: 0,
            status: 'active',
            campaignNumber: (highest?.campaignNumber ?? 0) + 1,
            displayOnProductPage: template.displayOnProductPage ?? false,
            minDisplayPercent: template.minDisplayPercent ?? 0,
            sizes: template.sizes,
            completedAt: null,
          });
        }
      }
    }

    // Manually reserved shares fill campaigns sequentially — top up the
    // current campaign to completion first, then spill the remainder
    // into the next campaign(s). Runs after save() so the stale
    // in-memory soldShares can't clobber the increment. Each campaign
    // gets its own manualShares portion + entry so the admin UI's
    // "orders vs manual" breakdown stays correct per campaign.
    if (addSoldShares !== undefined && addSoldShares > 0) {
      const allocations = await addReservedShares(
        campaign._id,
        addSoldShares,
      );
      for (const allocation of allocations) {
        await ShareCampaign.updateOne(
          { _id: allocation.campaign._id },
          {
            $inc: { manualShares: allocation.added },
            $push: {
              manualShareEntries: {
                count: allocation.added,
                addedAt: new Date(),
                addedById: auth.user.userId,
                addedByName: auth.user.name,
                addedByEmail: auth.user.email,
              },
            },
          },
        );
      }
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

    // Fully completed campaigns are permanent records — they can't
    // be deleted.
    if (campaign.status === 'completed') {
      return NextResponse.json(
        {
          success: false,
          error: 'Cannot delete a completed campaign',
        },
        { status: 400 },
      );
    }

    // Campaigns with sold shares can't be deleted — the shares must be
    // moved to another campaign first so no sale is lost.
    if (campaign.soldShares > 0) {
      return NextResponse.json(
        {
          success: false,
          error:
            'Cannot delete a campaign that has shares — move its shares to another campaign first',
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
