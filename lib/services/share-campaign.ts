import mongoose from 'mongoose';
import ShareCampaign, {
  type IShareCampaign,
} from '@/lib/models/ShareCampaign';
import Order from '@/lib/models/Order';

/**
 * Find the active share campaign for a product.
 *
 * Returns null if no active campaign exists. This is called by the
 * checkout route to silently detect whether a purchase is a share.
 */
export async function findActiveShareCampaign(
  productId: string | mongoose.Types.ObjectId,
): Promise<IShareCampaign | null> {
  return ShareCampaign.findOne({
    productId: new mongoose.Types.ObjectId(String(productId)),
    status: 'active',
  }).lean();
}

/**
 * Get the shares-per-purchase for a given size index in a campaign.
 *
 * Returns 0 if the size is not part of this campaign.
 */
export function getSharesForSize(
  campaign: IShareCampaign,
  sizeIndex: number,
): number {
  const entry = campaign.sizes.find((s) => s.sizeIndex === sizeIndex);
  return entry ? entry.sharesPerPurchase : 0;
}

/**
 * Atomically increment soldShares on a share campaign.
 *
 * Uses a conditional filter to prevent overselling — if soldShares
 * would exceed totalShares, the update matches 0 documents and
 * returns null.
 *
 * If the increment causes soldShares to reach totalShares, the
 * campaign is marked as completed and a new campaign is always
 * auto-created.
 *
 * @returns The updated campaign, or null if the shares were already
 *          sold out.
 */
export async function incrementShareCampaignSold(
  campaignId: string | mongoose.Types.ObjectId,
  sharesToAdd: number,
): Promise<IShareCampaign | null> {
  const campaign = await ShareCampaign.findById(campaignId).lean();
  if (!campaign) return null;

  if (campaign.soldShares + sharesToAdd > campaign.totalShares) {
    return null;
  }

  const updated = await ShareCampaign.findOneAndUpdate(
    {
      _id: campaign._id,
      status: 'active',
      soldShares: { $lte: campaign.totalShares - sharesToAdd },
    },
    {
      $inc: { soldShares: sharesToAdd },
    },
    { new: true },
  ).lean();

  if (!updated) return null;

  if (updated.soldShares >= updated.totalShares) {
    await ShareCampaign.updateOne(
      { _id: updated._id },
      { status: 'completed', completedAt: new Date() },
    );

    await createNextCampaign(updated);

    return await ShareCampaign.findById(updated._id).lean();
  }

  return updated;
}

/**
 * Auto-create the next campaign in the chain after one completes.
 *
 * Increments campaignNumber and resets soldShares to 0.
 * Inherits the same sizes configuration.
 */
async function createNextCampaign(
  completedCampaign: IShareCampaign,
): Promise<void> {
  try {
    await ShareCampaign.create({
      productId: completedCampaign.productId,
      totalShares: completedCampaign.totalShares,
      soldShares: 0,
      status: 'active',
      campaignNumber: completedCampaign.campaignNumber + 1,
      sizes: completedCampaign.sizes,
      completedAt: null,
    });
  } catch (error) {
    console.error('[shares] Failed to auto-create next campaign:', error);
  }
}

/**
 * Decrement soldShares on a share campaign (used on refund).
 *
 * The completed campaign stays completed with a decremented count.
 * The new campaign continues normally.
 */
export async function decrementShareCampaignSold(
  campaignId: string | mongoose.Types.ObjectId,
  sharesToRemove: number,
): Promise<void> {
  await ShareCampaign.updateOne(
    { _id: String(campaignId) },
    { $inc: { soldShares: -sharesToRemove } },
  );
}

/**
 * Count total orders that bought shares for a campaign.
 */
export async function countCampaignOrders(
  campaignId: string | mongoose.Types.ObjectId,
): Promise<number> {
  return Order.countDocuments({
    'items.shareCampaignId': new mongoose.Types.ObjectId(String(campaignId)),
    status: { $in: ['paid', 'partial-paid', 'completed'] },
  });
}
