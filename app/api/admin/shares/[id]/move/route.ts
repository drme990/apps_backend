import { NextRequest, NextResponse } from 'next/server';
import mongoose from 'mongoose';
import { z } from 'zod';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import ShareCampaign from '@/lib/models/ShareCampaign';
import Order from '@/lib/models/Order';
import { logActivity } from '@/lib/services/logger';
import { parseJsonBody } from '@/lib/validation/http';
import { incrementShareCampaignSold } from '@/lib/services/share-campaign';

export const maxDuration = 60;

const moveSharesSchema = z
  .object({
    targetCampaignId: z.string().trim().min(1),
    amount: z.number().int().min(1).optional(),
    orderId: z.string().trim().min(1).optional(),
  })
  .strict();

/**
 * POST /api/admin/shares/[id]/move
 *
 * Moves sold shares from this campaign to another campaign of the same
 * product. Needed before a campaign with shares can be deleted.
 *
 * - `amount` defaults to ALL sold shares on the source campaign.
 * - The target must be an active campaign for the same product.
 * - If the moved shares don't fit the target, incrementShareCampaignSold
 *   handles it the same way as orders — overflow creates a new campaign,
 *   a full count completes the target.
 * - Order items linked to the source are re-linked to whichever campaign
 *   the shares land on, up to the moved amount.
 * - manualShares moves proportionally so the orders/manual breakdown
 *   stays accurate.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess('orders');
    if ('error' in auth) return auth.error;

    const { id } = await params;
    const parsed = await parseJsonBody(request, moveSharesSchema);
    if (!parsed.success) return parsed.response;
    const { targetCampaignId, amount: requestedAmount, orderId } =
      parsed.data;

    const source = await ShareCampaign.findById(id);
    if (!source) {
      return NextResponse.json(
        { success: false, error: 'Campaign not found' },
        { status: 404 },
      );
    }

    if (source.status === 'completed') {
      return NextResponse.json(
        {
          success: false,
          error: 'Cannot move shares out of a completed campaign',
        },
        { status: 400 },
      );
    }
    if (source.soldShares <= 0 && !orderId) {
      return NextResponse.json(
        { success: false, error: 'This campaign has no shares to move' },
        { status: 400 },
      );
    }

    if (String(targetCampaignId) === String(source._id)) {
      return NextResponse.json(
        { success: false, error: 'Cannot move shares to the same campaign' },
        { status: 400 },
      );
    }

    const target = await ShareCampaign.findById(targetCampaignId).lean();
    if (!target || String(target.productId) !== String(source.productId)) {
      return NextResponse.json(
        {
          success: false,
          error: 'Target campaign not found for this product',
        },
        { status: 404 },
      );
    }
    if (target.status !== 'active') {
      return NextResponse.json(
        {
          success: false,
          error: 'Shares can only be moved to an active campaign',
        },
        { status: 400 },
      );
    }

    // ── Per-order swap ──
    // Move a single order's share items off this campaign onto the
    // target. Shares already counted (sharesApplied) move soldShares;
    // shares not yet counted (unpaid order) are just re-linked so the
    // increment lands on the target when the order is paid.
    // manualShares is untouched — it doesn't belong to any order.
    if (orderId) {
      if (!mongoose.Types.ObjectId.isValid(orderId)) {
        return NextResponse.json(
          { success: false, error: 'Invalid order id' },
          { status: 400 },
        );
      }

      const order = await Order.findById(orderId, {
        items: 1,
        orderNumber: 1,
      });
      if (!order) {
        return NextResponse.json(
          { success: false, error: 'Order not found' },
          { status: 404 },
        );
      }

      const items = (order.items || []) as Array<{
        isShare?: boolean;
        shareCampaignId?: mongoose.Types.ObjectId | string;
        shareQuantity?: number;
        sharesApplied?: boolean;
      }>;

      const linkedIdx: number[] = [];
      const appliedIdx: number[] = [];
      let linkedQty = 0;
      let appliedQty = 0;
      items.forEach((item, i) => {
        if (
          !item.isShare ||
          String(item.shareCampaignId || '') !== String(source._id)
        ) {
          return;
        }
        linkedIdx.push(i);
        linkedQty += item.shareQuantity || 0;
        if (item.sharesApplied && (item.shareQuantity || 0) > 0) {
          appliedIdx.push(i);
          appliedQty += item.shareQuantity || 0;
        }
      });

      if (linkedIdx.length === 0) {
        return NextResponse.json(
          {
            success: false,
            error: 'This order has no shares on this campaign',
          },
          { status: 400 },
        );
      }

      let landing: { _id?: unknown; campaignNumber: number } = target;
      if (appliedQty > 0) {
        const result = await incrementShareCampaignSold(
          target._id,
          appliedQty,
        );
        if (!result) {
          return NextResponse.json(
            {
              success: false,
              error: 'Failed to move shares to target campaign',
            },
            { status: 500 },
          );
        }
        landing = result;

        source.soldShares = Math.max(0, source.soldShares - appliedQty);
        await source.save();

        for (const i of appliedIdx) {
          await Order.updateOne(
            { _id: order._id },
            {
              $set: {
                [`items.${i}.shareCampaignId`]:
                  new mongoose.Types.ObjectId(String(landing._id)),
              },
            },
          );
        }
      }

      // Unapplied items re-link to the chosen target — their increment
      // runs on it when the order is paid.
      for (const i of linkedIdx.filter((i) => !appliedIdx.includes(i))) {
        await Order.updateOne(
          { _id: order._id },
          {
            $set: {
              [`items.${i}.shareCampaignId`]: new mongoose.Types.ObjectId(
                String(target._id),
              ),
            },
          },
        );
      }

      await logActivity({
        userId: auth.user.userId,
        userName: auth.user.name,
        userEmail: auth.user.email,
        action: 'update',
        resource: 'shareCampaign',
        resourceId: String(source._id),
        details: `Moved order ${order.orderNumber ?? order._id} (${linkedQty} share(s)) from campaign #${source.campaignNumber} to campaign #${landing.campaignNumber}`,
      });

      const [updatedSource, updatedTarget] = await Promise.all([
        ShareCampaign.findById(source._id).lean(),
        ShareCampaign.findById(landing._id).lean(),
      ]);

      return NextResponse.json({
        success: true,
        data: { source: updatedSource, target: updatedTarget },
      });
    }

    const amount = Math.min(
      requestedAmount ?? source.soldShares,
      source.soldShares,
    );
    if (amount < 1) {
      return NextResponse.json(
        { success: false, error: 'Amount must be at least 1' },
        { status: 400 },
      );
    }

    // Apply the increment on the target — may return a DIFFERENT campaign
    // (overflow creates a new active one, a full count creates a completed one)
    const result = await incrementShareCampaignSold(target._id, amount);
    if (!result) {
      return NextResponse.json(
        { success: false, error: 'Failed to move shares to target campaign' },
        { status: 500 },
      );
    }

    // Debit the source — manual portion moves with the shares
    const sourceManual = Math.max(0, source.manualShares || 0);
    const manualMoved = Math.min(sourceManual, amount);
    source.soldShares = Math.max(0, source.soldShares - amount);
    source.manualShares = Math.max(0, sourceManual - manualMoved);

    // Move manual entries (most recent first, split if partial) so the
    // destination keeps the original add date + admin for each entry.
    const movedEntries: Array<{
      count: number;
      addedAt: Date;
      addedById?: string;
      addedByName?: string;
      addedByEmail?: string;
    }> = [];
    if (manualMoved > 0) {
      const entries = [...(source.manualShareEntries || [])];
      let remaining = manualMoved;
      while (remaining > 0 && entries.length > 0) {
        const last = entries[entries.length - 1];
        if (last.count <= remaining) {
          movedEntries.unshift(entries.pop()!);
          remaining -= last.count;
        } else {
          movedEntries.unshift({ ...last, count: remaining });
          last.count -= remaining;
          remaining = 0;
        }
      }
      source.manualShareEntries = entries;
    }
    await source.save();

    // Credit manual shares on whichever campaign received them
    if (manualMoved > 0) {
      await ShareCampaign.updateOne(
        { _id: result._id },
        {
          $inc: { manualShares: manualMoved },
          ...(movedEntries.length > 0
            ? { $push: { manualShareEntries: { $each: movedEntries } } }
            : {}),
        },
      );
    }

    // Re-link order items pointing at the source to the campaign the
    // shares landed on — greedy, whole items only, up to `amount`.
    const orders = await Order.find(
      {
        'items.shareCampaignId': new mongoose.Types.ObjectId(
          String(source._id),
        ),
      },
      { items: 1 },
    );

    let covered = 0;
    for (const order of orders) {
      if (covered >= amount) break;
      const items = (order.items || []) as Array<{
        shareCampaignId?: mongoose.Types.ObjectId | string;
        shareQuantity?: number;
      }>;
      for (let i = 0; i < items.length; i++) {
        if (covered >= amount) break;
        const item = items[i];
        if (String(item.shareCampaignId || '') !== String(source._id)) {
          continue;
        }
        // Whole-item relinks only — skip items that would exceed the
        // moved amount (an item's shares can't be split).
        const qty = item.shareQuantity || 0;
        if (covered + qty > amount) continue;
        await Order.updateOne(
          { _id: order._id },
          {
            $set: {
              [`items.${i}.shareCampaignId`]: new mongoose.Types.ObjectId(
                String(result._id),
              ),
            },
          },
        );
        covered += item.shareQuantity || 0;
      }
    }

    await logActivity({
      userId: auth.user.userId,
      userName: auth.user.name,
      userEmail: auth.user.email,
      action: 'update',
      resource: 'shareCampaign',
      resourceId: String(source._id),
      details: `Moved ${amount} share(s) from campaign #${source.campaignNumber} to campaign #${result.campaignNumber}`,
    });

    const updatedSource = await ShareCampaign.findById(source._id).lean();
    const updatedTarget = await ShareCampaign.findById(result._id).lean();

    return NextResponse.json({
      success: true,
      data: { source: updatedSource, target: updatedTarget },
    });
  } catch (error) {
    console.error('Error moving shares:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to move shares' },
      { status: 500 },
    );
  }
}
