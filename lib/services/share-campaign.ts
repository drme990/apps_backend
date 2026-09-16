import mongoose from 'mongoose';
import ShareCampaign, {
  type IShareCampaign,
} from '@/lib/models/ShareCampaign';
import Order from '@/lib/models/Order';

/**
 * Find the best active share campaign for a product.
 *
 * If `sharesToFit` is provided, finds the active campaign that can
 * accommodate the order's shares (soldShares + sharesToFit <= totalShares),
 * preferring the one closest to completion (highest soldShares).
 *
 * If no campaign can fit, returns the oldest active campaign (lowest
 * campaignNumber) — the webhook will create a new campaign for this order.
 *
 * If `sharesToFit` is not provided, returns the oldest active campaign.
 *
 * Returns null if no active campaign exists.
 */
export async function findActiveShareCampaign(
  productId: string | mongoose.Types.ObjectId,
  sharesToFit?: number,
): Promise<IShareCampaign | null> {
  const pid = new mongoose.Types.ObjectId(String(productId));

  if (sharesToFit && sharesToFit > 0) {
    // Find the campaign that can fit the order, closest to completion first
    const fit = await ShareCampaign.findOne({
      productId: pid,
      status: 'active',
      $expr: {
        $lte: [{ $add: ['$soldShares', sharesToFit] }, '$totalShares'],
      },
    })
      .sort({ soldShares: -1 })
      .lean();

    if (fit) return fit;

    // None can fit — return the oldest active campaign.
    // The webhook will create a new campaign for this order.
  }

  return ShareCampaign.findOne({
    productId: pid,
    status: 'active',
  })
    .sort({ campaignNumber: 1 })
    .lean();
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
 * Increment soldShares on a share campaign.
 *
 * Three cases:
 *
 * 1. **Full order** (sharesToAdd >= totalShares):
 *    Create a new completed campaign (soldShares = totalShares).
 *    The current active campaign is left unchanged.
 *
 * 2. **Fits in current campaign** (soldShares + sharesToAdd <= totalShares):
 *    Atomically increment soldShares. If it reaches totalShares, mark
 *    as completed and auto-create the next campaign (only if no other
 *    active campaigns exist for this product).
 *
 * 3. **Overflow** (sharesToAdd < totalShares but doesn't fit):
 *    Create a new active campaign with soldShares = sharesToAdd.
 *    The current active campaign is left unchanged.
 *
 * @returns The updated (or newly created) campaign, or null on failure.
 *          The returned campaign may have a different _id than the one
 *          passed in (cases 1 and 3), so the caller should re-link
 *          the order item's shareCampaignId.
 */
export async function incrementShareCampaignSold(
  campaignId: string | mongoose.Types.ObjectId,
  sharesToAdd: number,
): Promise<IShareCampaign | null> {
  const campaign = await ShareCampaign.findById(campaignId).lean();
  if (!campaign) return null;

  // ── Case 1: Full order ──
  // One order can complete a full campaign on its own.
  // Create a new completed campaign, leave the current one unchanged.
  //
  // Example:
  //   Campaign #5: 2/10 (active)
  //   Order: 10 shares (= totalShares)
  //   → Create Campaign #6: 10/10 (completed)
  //   → Keep Campaign #5: 2/10 (active)
  if (sharesToAdd >= campaign.totalShares) {
    return await createCompletedCampaignForFullOrder(campaign);
  }

  // ── Case 2: Fits in current campaign ──
  if (campaign.soldShares + sharesToAdd <= campaign.totalShares) {
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

  // ── Case 3: Overflow ──
  // The order's shares don't fit in the current campaign, but are
  // less than totalShares. Create a new active campaign with the
  // order's shares as soldShares.
  //
  // Example:
  //   Campaign #5: 9/10 (active, remaining = 1)
  //   Order: 2 shares
  //   → Create Campaign #6: 2/10 (active)
  //   → Keep Campaign #5: 9/10 (active)
  //   → A 1-share order will complete #5 to 10/10
  //   → A 2-share order will increment #6 to 4/10
  return await createActiveCampaignForOverflow(campaign, sharesToAdd);
}

/**
 * Create a new completed campaign for a full order.
 *
 * soldShares = totalShares, status = 'completed'.
 * The current active campaign is left unchanged.
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
      displayOnProductPage: templateCampaign.displayOnProductPage ?? false,
      minDisplayPercent: templateCampaign.minDisplayPercent ?? 0,
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
 * Create a new active campaign for an overflow order.
 *
 * soldShares = sharesToAdd, status = 'active'.
 * The current active campaign is left unchanged.
 *
 * Multiple active campaigns can coexist for the same product.
 */
async function createActiveCampaignForOverflow(
  templateCampaign: IShareCampaign,
  sharesToAdd: number,
): Promise<IShareCampaign | null> {
  try {
    const nextNumber = await getNextCampaignNumber(templateCampaign.productId);

    const created = await ShareCampaign.create({
      productId: templateCampaign.productId,
      totalShares: templateCampaign.totalShares,
      soldShares: sharesToAdd,
      status: 'active',
      campaignNumber: nextNumber,
      displayOnProductPage: templateCampaign.displayOnProductPage ?? false,
      minDisplayPercent: templateCampaign.minDisplayPercent ?? 0,
      sizes: templateCampaign.sizes,
      completedAt: null,
    });

    return created.toObject();
  } catch (error) {
    console.error(
      '[shares] Failed to create overflow campaign:',
      error,
    );
    return null;
  }
}

/**
 * Find the next available campaign number for a product.
 *
 * Returns the highest existing campaignNumber + 1 (or 1 if none exist).
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
 * Auto-create the next campaign after one completes.
 *
 * Only creates a new active campaign if no other active campaigns
 * exist for this product (there can be multiple active campaigns
 * when orders overflow the current one).
 *
 * Uses the highest existing campaign number + 1 so it never
 * conflicts with already-completed campaigns.
 */
async function createNextCampaign(
  completedCampaign: IShareCampaign,
): Promise<void> {
  try {
    // Check if other active campaigns exist for this product
    const activeCount = await ShareCampaign.countDocuments({
      productId: completedCampaign.productId,
      status: 'active',
    });

    // Other active campaigns exist — don't create a new one
    if (activeCount > 0) return;

    const nextNumber = await getNextCampaignNumber(completedCampaign.productId);

    await ShareCampaign.create({
      productId: completedCampaign.productId,
      totalShares: completedCampaign.totalShares,
      soldShares: 0,
      status: 'active',
      campaignNumber: nextNumber,
      displayOnProductPage: completedCampaign.displayOnProductPage ?? false,
      minDisplayPercent: completedCampaign.minDisplayPercent ?? 0,
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
 * Active campaigns continue normally.
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
