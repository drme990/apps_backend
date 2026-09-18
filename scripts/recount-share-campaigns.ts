/**
 * Recount share campaigns from real orders.
 *
 * Rebuilds `soldShares` for every NON-completed campaign purely from
 * qualifying orders in the scan window — wiping any manually-added
 * shares (manualShares is reset to 0; previously manual additions were
 * folded into soldShares with no way to tell them apart).
 *
 * How it works per product:
 *   1. Completed campaigns are untouched (locked historical records).
 *   2. Qualifying orders (paid / partial-paid / completed) in the window
 *      contribute their share quantities. Items already linked to a
 *      campaign keep that attribution; unlinked share items are filled
 *      into ACTIVE campaigns in campaign-number order. Inactive
 *      campaigns keep only their explicitly linked shares.
 *   3. Any leftover shares that exceed all active campaigns' capacity
 *      create new campaigns (completed if they fill up).
 *   4. Attributed order items are marked `sharesApplied` and re-linked
 *      so a later webhook/status change can't double-count them.
 *
 * Usage:
 *   npx tsx scripts/recount-share-campaigns.ts                    # from 2026-09-16 (default)
 *   npx tsx scripts/recount-share-campaigns.ts --from 2026-09-01  # custom start date
 *   npx tsx scripts/recount-share-campaigns.ts --days 7           # last N days instead
 *   npx tsx scripts/recount-share-campaigns.ts --days 0           # all orders
 *   npx tsx scripts/recount-share-campaigns.ts --dry              # report only, no writes
 *   npx tsx scripts/recount-share-campaigns.ts mongodb+srv://...  # custom DB URI
 */
import mongoose from 'mongoose';
import Order from '../lib/models/Order';
import ShareCampaign from '../lib/models/ShareCampaign';

// MongoDB connection string resolution order:
// 1. First non-option command-line argument (e.g. tsx script.ts mongodb+srv://...)
// 2. DATA_BASE_URL env var
// 3. MONGODB_URI env var
// 4. Production fallback
const cliUri = process.argv.find(
  (arg) => arg.startsWith('mongodb://') || arg.startsWith('mongodb+srv://'),
);
const MONGODB_URI =
  cliUri ||
  process.env.DATA_BASE_URL ||
  process.env.MONGODB_URI ||
  'mongodb://localhost:27017/manasik';

type CampaignDoc = {
  _id: mongoose.Types.ObjectId;
  productId: mongoose.Types.ObjectId;
  totalShares: number;
  soldShares: number;
  manualShares?: number;
  status: 'active' | 'inactive' | 'completed';
  campaignNumber: number;
  displayOnProductPage?: boolean;
  minDisplayPercent?: number;
  sizes: Array<{ sizeIndex: number; sharesPerPurchase: number }>;
};

type OrderItemDoc = {
  productId?: mongoose.Types.ObjectId | string;
  sizeIndex?: number;
  quantity?: number;
  isShare?: boolean;
  shareCampaignId?: mongoose.Types.ObjectId | string;
  shareQuantity?: number;
  sharesApplied?: boolean;
};

type OrderDoc = {
  _id: mongoose.Types.ObjectId;
  orderNumber: string;
  status: string;
  items?: OrderItemDoc[];
};

type UnlinkedItem = {
  order: OrderDoc;
  itemIndex: number;
  shares: number;
};

const PAID_STATUSES = ['paid', 'partial-paid', 'completed'];

const DEFAULT_FROM = '2026-09-16';

function parseArgs() {
  const args = process.argv.slice(2);
  let days: number | null = null;
  let from: string | null = null;
  let dry = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--days' && args[i + 1]) {
      days = Number.parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--from' && args[i + 1]) {
      from = args[i + 1];
      i++;
    } else if (args[i] === '--dry') {
      dry = true;
    }
  }

  // Window start: --from wins, then --days, then the default start date.
  // --days 0 means "all orders" (no cutoff).
  let cutoff: Date | null;
  let windowLabel: string;
  if (from && /^\d{4}-\d{2}-\d{2}$/.test(from)) {
    cutoff = new Date(`${from}T00:00:00.000Z`);
    windowLabel = `orders since ${from}`;
  } else if (days !== null) {
    cutoff =
      days > 0 ? new Date(Date.now() - days * 24 * 60 * 60 * 1000) : null;
    windowLabel = days > 0 ? `last ${days} day(s)` : 'ALL orders';
  } else {
    cutoff = new Date(`${DEFAULT_FROM}T00:00:00.000Z`);
    windowLabel = `orders since ${DEFAULT_FROM}`;
  }

  return { cutoff, windowLabel, dry };
}

/** Mark an order item as a counted share linked to a campaign. */
async function relinkItem(
  orderId: mongoose.Types.ObjectId,
  itemIndex: number,
  campaignId: mongoose.Types.ObjectId,
): Promise<void> {
  await Order.updateOne(
    { _id: orderId },
    {
      $set: {
        [`items.${itemIndex}.isShare`]: true,
        [`items.${itemIndex}.shareCampaignId`]: campaignId,
        [`items.${itemIndex}.sharesApplied`]: true,
      },
    },
  );
}

async function recount() {
  const { cutoff, windowLabel, dry } = parseArgs();

  console.log(`Connecting to: ${MONGODB_URI.replace(/\/\/.*@/, '//<credentials>@')}`);
  await mongoose.connect(MONGODB_URI, {
    bufferCommands: false,
    maxPoolSize: 10,
    minPoolSize: 1,
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
    connectTimeoutMS: 10000,
    family: 4,
  });
  console.log('Connected to MongoDB');

  console.log(
    `\n=== Share campaign recount ===\nWindow: ${windowLabel}\nMode: ${dry ? 'DRY RUN (no writes)' : 'LIVE'}\n`,
  );

  const refactorTargets = (await ShareCampaign.find({
    status: { $ne: 'completed' },
  }).lean()) as unknown as CampaignDoc[];
  const productIds = [
    ...new Set(refactorTargets.map((c) => String(c.productId))),
  ];

  let ordersScanned = 0;
  let campaignsUpdated = 0;
  let campaignsCreated = 0;
  let itemsRelinked = 0;

  for (const pidStr of productIds) {
    const productId = new mongoose.Types.ObjectId(pidStr);
    const allCampaigns = (await ShareCampaign.find({ productId })
      .sort({ campaignNumber: 1 })
      .lean()) as unknown as CampaignDoc[];
    const active = allCampaigns.filter((c) => c.status === 'active');
    const open = allCampaigns.filter((c) => c.status !== 'completed');
    if (open.length === 0) continue;

    // sizeIndex -> sharesPerPurchase (union across this product's campaigns)
    const sizeShares = new Map<number, number>();
    for (const c of allCampaigns) {
      for (const s of c.sizes || []) {
        sizeShares.set(s.sizeIndex, s.sharesPerPurchase);
      }
    }
    const campaignIds = new Set(allCampaigns.map((c) => String(c._id)));

    const orderFilter: Record<string, unknown> = {
      status: { $in: PAID_STATUSES },
      'items.productId': productId,
    };
    if (cutoff) orderFilter.createdAt = { $gte: cutoff };

    const orders = (await Order.find(orderFilter, {
      orderNumber: 1,
      status: 1,
      items: 1,
    })
      .sort({ createdAt: 1 })
      .lean()) as unknown as OrderDoc[];
    ordersScanned += orders.length;

    // Attribute shares: linked to a known campaign vs unlinked pool
    const linked = new Map<string, number>();
    const linkedItemsByCampaign = new Map<string, UnlinkedItem[]>();
    const unlinkedItems: UnlinkedItem[] = [];

    for (const order of orders) {
      (order.items || []).forEach((item, itemIndex) => {
        if (String(item.productId || '') !== pidStr) return;

        const cid = item.shareCampaignId ? String(item.shareCampaignId) : null;
        if (item.isShare && item.shareQuantity && cid && campaignIds.has(cid)) {
          linked.set(cid, (linked.get(cid) || 0) + item.shareQuantity);
          const list = linkedItemsByCampaign.get(cid) || [];
          list.push({ order, itemIndex, shares: item.shareQuantity });
          linkedItemsByCampaign.set(cid, list);
          return;
        }

        // Unlinked — fall back to size coverage on this product's campaigns
        const sizeIndex = Number(item.sizeIndex ?? -1);
        const sharesPer = sizeShares.get(sizeIndex) || 0;
        if (sharesPer <= 0) return;

        const shares =
          item.isShare && item.shareQuantity
            ? item.shareQuantity
            : sharesPer * (item.quantity || 1);
        unlinkedItems.push({ order, itemIndex, shares });
      });
    }

    // Distribute the unlinked pool into ACTIVE campaigns in order —
    // each fills its remaining capacity before the next one takes over.
    const assignedByCampaign = new Map<string, UnlinkedItem[]>();
    const pool = [...unlinkedItems];
    for (const campaign of active) {
      const linkedCount = linked.get(String(campaign._id)) || 0;
      const capacity = Math.max(0, campaign.totalShares - linkedCount);
      const assigned: UnlinkedItem[] = [];
      let remaining = capacity;
      while (remaining > 0 && pool.length > 0) {
        const it = pool.shift()!;
        assigned.push(it);
        remaining -= it.shares;
      }
      assignedByCampaign.set(String(campaign._id), assigned);
    }

    let nextNumber =
      Math.max(...allCampaigns.map((c) => c.campaignNumber), 0) + 1;
    const template = allCampaigns[allCampaigns.length - 1];

    // ── Update each open campaign ──
    for (const campaign of open) {
      const isActive = campaign.status === 'active';
      const linkedCount = linked.get(String(campaign._id)) || 0;
      const assigned = isActive
        ? assignedByCampaign.get(String(campaign._id)) || []
        : [];
      const assignedShares = assigned.reduce((s, it) => s + it.shares, 0);
      const newSold = linkedCount + assignedShares;
      const completes = newSold >= campaign.totalShares;

      const changed =
        campaign.soldShares !== newSold || (campaign.manualShares ?? 0) !== 0;
      console.log(
        `  product ${pidStr} campaign #${campaign.campaignNumber} (${campaign.status}): ` +
        `${campaign.soldShares} → ${newSold}/${campaign.totalShares}` +
        `${(campaign.manualShares ?? 0) > 0 ? ` (cleared ${campaign.manualShares} manual)` : ''}` +
        `${completes ? ' → COMPLETED' : ''}`,
      );

      if (dry) continue;

      if (changed) {
        await ShareCampaign.updateOne(
          { _id: campaign._id },
          {
            $set: {
              soldShares: newSold,
              manualShares: 0,
              ...(completes
                ? { status: 'completed', completedAt: new Date() }
                : {}),
            },
          },
        );
        campaignsUpdated++;
      }

      // Relink newly-attributed items
      for (const { order, itemIndex } of assigned) {
        await relinkItem(order._id, itemIndex, campaign._id);
        itemsRelinked++;
      }
      // Flag already-linked items that were never marked applied
      for (const { order, itemIndex } of linkedItemsByCampaign.get(
        String(campaign._id),
      ) || []) {
        const item = order.items?.[itemIndex];
        if (item && !item.sharesApplied) {
          await Order.updateOne(
            { _id: order._id },
            { $set: { [`items.${itemIndex}.sharesApplied`]: true } },
          );
          itemsRelinked++;
        }
      }
    }

    // ── Leftover pool → new campaigns ──
    while (pool.length > 0) {
      const cap = template?.totalShares || 1;
      const assigned: UnlinkedItem[] = [];
      let remaining = cap;
      while (remaining > 0 && pool.length > 0) {
        const it = pool.shift()!;
        assigned.push(it);
        remaining -= it.shares;
      }
      const sold = assigned.reduce((s, it) => s + it.shares, 0);
      const completes = template ? sold >= template.totalShares : false;
      console.log(
        `  product ${pidStr}: + new campaign #${nextNumber} ` +
        `${sold}/${template?.totalShares} ${completes ? '(completed)' : '(active)'}`,
      );
      if (!dry) {
        const created = await ShareCampaign.create({
          productId,
          totalShares: template?.totalShares || sold,
          soldShares: sold,
          manualShares: 0,
          status: completes ? 'completed' : 'active',
          campaignNumber: nextNumber,
          displayOnProductPage: template?.displayOnProductPage ?? false,
          minDisplayPercent: template?.minDisplayPercent ?? 0,
          sizes: template?.sizes || [],
          completedAt: completes ? new Date() : null,
        });
        campaignsCreated++;
        for (const { order, itemIndex } of assigned) {
          await relinkItem(order._id, itemIndex, created._id);
          itemsRelinked++;
        }
      }
      nextNumber++;
    }
  }

  console.log(
    `\nDone. Orders scanned: ${ordersScanned} | campaigns updated: ${campaignsUpdated} | campaigns created: ${campaignsCreated} | items relinked: ${itemsRelinked}\n`,
  );

  await mongoose.disconnect();
}

recount().catch((err) => {
  console.error('Recount failed:', err);
  process.exit(1);
});
