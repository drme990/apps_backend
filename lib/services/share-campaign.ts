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
 * **Full-order shortcut:** If a single order's sharesToAdd is >=
 * totalShares (one order can complete a full campaign on its own),
 * a NEW campaign is created as completed (soldShares = totalShares)
 * and the current active campaign is left unchanged. The returned
 * campaign will have a different _id than the one passed in, so the
 * caller (webhook) can update the order item's shareCampaignId.
 *
 * If the increment causes soldShares to reach totalShares, the
 * campaign is marked as completed and a new campaign is always
 * auto-created.
 *
 * @returns The updated (or newly created) campaign, or null if the
 *          shares were already sold out.
 */
export async function incrementShareCampaignSold(
  campaignId: string | mongoose.Types.ObjectId,
  sharesToAdd: number,
): Promise<IShareCampaign | null> {
  const campaign = await ShareCampaign.findById(campaignId).lean();
  if (!campaign) return null;

  // ── Full-order shortcut ──
  // If this single order can complete a full campaign on its own,
  // create a new completed campaign instead of adding to the current
  // one. This keeps the current active campaign running.
  //
  // Example:
  //   Campaign #5: 2/10 (active)
  //   Order: 10 shares (= totalShares)
  //   → Create Campaign #6: 10/10 (completed)
  //   → Keep Campaign #5: 2/10 (active)
  //   → When #5 completes, next is #7 (not #6, which is already done)
  if (sharesToAdd >= campaign.totalShares) {
    return await createCompletedCampaignForFullOrder(campaign);
  }

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
 * Create a new completed campaign for a single order that can
 * complete a full campaign on its own.
 *
 * The new campaign is marked as completed immediately with
 * soldShares = totalShares. The current active campaign is
 * left unchanged.
 *
 * The campaign number is the highest existing number + 1 for this
 * product, so it never conflicts with already-completed campaigns
 * created by previous full orders.
 */
async function createCompletedCampaignForFullOrder(
  templateCampaign: IShareCampaign,
): Promise<IShareCampaign | null> {
  try {
    const nextNumber = await getNextCampaignNumber(templateCampaign.productId);

    const created = await ShareCampaign.create({
      productId: templateCampaign.productId,
      totalShares: templateCampaign.totalShares,
      soldShares: templateCampaign.totalShares,
      status: 'completed',
      campaignNumber: nextNumber,
      sizes: templateCampaign.sizes,
      completedAt: new Date(),
    });

    return created.toObject();
  } catch (error) {
    console.error(
      '[shares] Failed to create completed campaign for full order:',
      error,
    );
    return null;
  }
}

/**
 * Find the next available campaign number for a product.
 *
 * Returns the highest existing campaignNumber + 1 (or 1 if none exist).
 * This ensures new campaigns never conflict with already-completed
 * campaigns created by full orders.
 */
async function getNextCampaignNumber(
  productId: mongoose.Types.ObjectId | string,
): Promise<number> {
  const highest = await ShareCampaign.findOne(
    { productId: new mongoose.Types.ObjectId(String(productId)) },
    {},
    { sort: { campaignNumber: -1 } },
  ).lean();

  return highest ? highest.campaignNumber + 1 : 1;
}

/**
 * Auto-create the next campaign in the chain after one completes.
 *
 * Uses the highest existing campaign number + 1 (not just the
 * completed campaign's number + 1) so it never conflicts with
 * already-completed campaigns created by full orders.
 *
 * Resets soldShares to 0 and inherits the same sizes configuration.
 */
async function createNextCampaign(
  completedCampaign: IShareCampaign,
): Promise<void> {
  try {
    const nextNumber = await getNextCampaignNumber(completedCampaign.productId);

    await ShareCampaign.create({
      productId: completedCampaign.productId,
      totalShares: completedCampaign.totalShares,
      soldShares: 0,
      status: 'active',
      campaignNumber: nextNumber,
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
