import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import ShareCampaign from '@/lib/models/ShareCampaign';
import Product from '@/lib/models/Product';
import { logActivity } from '@/lib/services/logger';
import { parseJsonBody } from '@/lib/validation/http';
import { shareCampaignUpdateSchema } from '@/lib/validation/schemas';
import {
  addReservedShares,
  logShareCampaignChange,
  type ShareCampaignActor,
} from '@/lib/services/share-campaign';

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

    const actor: ShareCampaignActor = {
      userId: auth.user.userId,
      name: auth.user.name,
      email: auth.user.email,
    };
    const productDoc = await Product.findById(campaign.productId, {
      name: 1,
    }).lean();
    const productName = productDoc?.name ?? null;

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
      const prevNumber = campaign.campaignNumber;
      campaign.campaignNumber = campaignNumber;
      await logShareCampaignChange({
        campaign,
        productName,
        changeType: 'campaignNumber',
        previousValue: `#${prevNumber}`,
        newValue: `#${campaignNumber}`,
        changedBy: actor,
      });
    }

    if (status !== undefined && status !== campaign.status) {
      const prevStatus = campaign.status;
      campaign.status = status;
      await logShareCampaignChange({
        campaign,
        productName,
        changeType: 'status',
        previousValue: prevStatus,
        newValue: status,
        changedBy: actor,
      });
    }
    if (
      displayOnProductPage !== undefined &&
      displayOnProductPage !== campaign.displayOnProductPage
    ) {
      const prev = campaign.displayOnProductPage ?? false;
      campaign.displayOnProductPage = displayOnProductPage;
      await logShareCampaignChange({
        campaign,
        productName,
        changeType: 'displayOnProductPage',
        previousValue: prev,
        newValue: displayOnProductPage,
        changedBy: actor,
      });
    }
    if (
      minDisplayPercent !== undefined &&
      minDisplayPercent !== campaign.minDisplayPercent
    ) {
      const prev = campaign.minDisplayPercent ?? 0;
      campaign.minDisplayPercent = minDisplayPercent;
      await logShareCampaignChange({
        campaign,
        productName,
        changeType: 'minDisplayPercent',
        previousValue: `${prev}%`,
        newValue: `${minDisplayPercent}%`,
        changedBy: actor,
      });
    }

    await campaign.save();

    // totalShares applies to EVERY active campaign for this product —
    // it affects the current campaigns now, and the next campaigns
    // inherit it automatically (auto-created campaigns copy
    // totalShares from the campaign they were created from).
    if (totalShares !== undefined) {
      // Snapshot the affected campaigns BEFORE the bulk update so each
      // history entry shows its own previous totalShares.
      const affectedActive = await ShareCampaign.find(
        { productId: campaign.productId, status: 'active' },
        { totalShares: 1, campaignNumber: 1, productId: 1 },
      ).lean();

      await ShareCampaign.updateMany(
        { productId: campaign.productId, status: 'active' },
        { totalShares },
      );

      for (const affected of affectedActive) {
        if (affected.totalShares === totalShares) continue;
        await logShareCampaignChange({
          campaign: affected,
          productName,
          changeType: 'totalShares',
          previousValue: affected.totalShares,
          newValue: totalShares,
          details: 'Applied to all active campaigns of the product',
          changedBy: actor,
        });
      }

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

        for (const completed of overflowed) {
          await logShareCampaignChange({
            campaign: completed,
            productName,
            changeType: 'autoCompleted',
            previousValue: 'active',
            newValue: 'completed',
            details: `${completed.soldShares}/${totalShares} shares`,
            changedBy: actor,
          });
        }

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
          const nextCampaign = await ShareCampaign.create({
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
          await logShareCampaignChange({
            campaign: nextCampaign.toObject(),
            productName,
            changeType: 'autoCreated',
            newValue: `#${nextCampaign.campaignNumber}`,
            details: `Auto-created after campaign #${template.campaignNumber} completed`,
            changedBy: actor,
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

    const productDoc = await Product.findById(campaign.productId, {
      name: 1,
    }).lean();
    await logShareCampaignChange({
      campaign: campaign.toObject(),
      productName: productDoc?.name ?? null,
      changeType: 'deleted',
      previousValue: `#${campaign.campaignNumber}`,
      details: `status: ${campaign.status}, shares: ${campaign.soldShares}/${campaign.totalShares}`,
      changedBy: {
        userId: auth.user.userId,
        name: auth.user.name,
        email: auth.user.email,
      },
    });

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
