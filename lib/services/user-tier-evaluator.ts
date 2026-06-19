/**
 * User Tier Evaluation Service
 *
 * Evaluates which tier a user belongs to based on:
 * 1. Lifetime paid spending per currency (OR condition)
 * 2. Lifetime paid order count (OR condition)
 *
 * A user qualifies for a tier if they meet EITHER:
 * - The spending threshold for ANY currency, OR
 * - The minimum paid order count
 *
 * Tiers are sorted by baseAmount DESC. The highest qualifying tier is assigned.
 *
 * Performance:
 * - Single-user evaluation: one Order query per user (fast, used on payment webhooks).
 * - Bulk evaluation: one aggregation query pre-computes ALL user stats, then
 *   batches through users. No N+1 Order queries.
 */

import Order from '@/lib/models/Order';
import UserTier, { IUserTier } from '@/lib/models/UserTier';
import { getUserModelByAppId, type AppId } from '@/lib/auth/app-users';

const PAID_STATUSES = ['paid', 'partial-paid', 'completed'];

type SpendingMap = Record<string, number>;

interface UserLifetimeStats {
  spending: SpendingMap;
  orderCount: number;
}

/**
 * Returns lifetime paid spending per currency + total paid order count
 * for a single user across all sources.
 */
async function getUserLifetimeStats(userId: string): Promise<UserLifetimeStats> {
  const orders = await Order.find({
    userId,
    status: { $in: PAID_STATUSES },
    isGuest: false,
  })
    .select('paidAmount totalAmount currency')
    .lean();

  const spending: SpendingMap = {};
  let orderCount = 0;

  for (const order of orders) {
    const currency = (order.currency || '').toUpperCase();
    if (!currency) continue;

    const paid =
      typeof order.paidAmount === 'number' && order.paidAmount > 0
        ? order.paidAmount
        : typeof order.totalAmount === 'number'
          ? order.totalAmount
          : 0;

    spending[currency] = (spending[currency] || 0) + paid;
    orderCount++;
  }

  return { spending, orderCount };
}

/**
 * Checks if a user qualifies for a given tier.
 * Qualifies if spending in ANY currency meets the threshold OR
 * if total paid order count meets minimumOrders.
 */
function userQualifiesForTier(
  stats: UserLifetimeStats,
  tier: IUserTier,
): boolean {
  if (tier.minimumOrders > 0 && stats.orderCount >= tier.minimumOrders) {
    return true;
  }

  for (const minAmount of tier.minimumAmounts) {
    const currency = minAmount.currencyCode.toUpperCase();
    const userSpent = stats.spending[currency] || 0;
    if (userSpent >= minAmount.amount) {
      return true;
    }
  }

  return false;
}

/**
 * Determines the best tier for a user.
 * Tiers must be sorted by baseAmount DESC (highest threshold first).
 * The FIRST qualifying tier is the highest (best) one.
 */
function pickBestTier(
  stats: UserLifetimeStats,
  tiers: IUserTier[],
): IUserTier | null {
  for (const tier of tiers) {
    if (userQualifiesForTier(stats, tier)) {
      return tier;
    }
  }
  return null;
}

/**
 * Evaluates and updates the tier for a single user by userId and appId.
 * Sets/removes the `tier` field on the user document.
 */
export async function evaluateAndUpdateUserTier(
  userId: string,
  appId: Exclude<AppId, 'admin_panel'>,
): Promise<void> {
  try {
    const [tiers, stats] = await Promise.all([
      UserTier.find().sort({ baseAmount: -1 }).lean(),
      getUserLifetimeStats(userId),
    ]);

    const bestTier = pickBestTier(stats, tiers);

    const UserModel = getUserModelByAppId(appId);
    await (UserModel as unknown as { findByIdAndUpdate: (...args: unknown[]) => Promise<unknown> }).findByIdAndUpdate(userId, {
      $set: { tier: bestTier ? String(bestTier._id) : null },
    });
  } catch (error) {
    console.error(
      `[UserTierEvaluator] Failed to evaluate tier for user ${userId}:`,
      error,
    );
  }
}

/* ─── Bulk Evaluation (Performance-Optimized) ─────────────────────────── */

/** Pre-computed stats for every userId from the orders collection. */
interface PrecomputedUserStats {
  spending: SpendingMap;
  orderCount: number;
}

/**
 * Runs a single MongoDB aggregation to compute lifetime stats
 * (spending per currency + order count) for ALL non-guest users
 * with paid/partial-paid/completed orders.
 */
async function getAllUserStats(): Promise<Map<string, PrecomputedUserStats>> {
  const pipeline = [
    {
      $match: {
        status: { $in: PAID_STATUSES },
        isGuest: false,
        userId: { $exists: true, $ne: null },
      },
    },
    {
      $group: {
        _id: {
          userId: '$userId',
          currency: { $toUpper: { $ifNull: ['$currency', ''] } },
        },
        spent: {
          $sum: {
            $cond: [
              { $gt: ['$paidAmount', 0] },
              '$paidAmount',
              { $ifNull: ['$totalAmount', 0] },
            ],
          },
        },
        orders: { $sum: 1 },
      },
    },
    {
      $group: {
        _id: '$_id.userId',
        currencies: {
          $push: {
            currency: '$_id.currency',
            spent: '$spent',
            orders: '$orders',
          },
        },
      },
    },
  ];

  const rows = await Order.aggregate(pipeline);

  const map = new Map<string, PrecomputedUserStats>();

  for (const row of rows) {
    const userId = String(row._id);
    const spending: SpendingMap = {};
    let orderCount = 0;

    for (const entry of row.currencies as Array<{
      currency: string;
      spent: number;
      orders: number;
    }>) {
      if (entry.currency) {
        spending[entry.currency] = entry.spent;
      }
      orderCount += entry.orders;
    }

    map.set(userId, { spending, orderCount });
  }

  return map;
}

/**
 * Bulk-evaluates and updates tiers for ALL users across all sources.
 * Uses a single aggregation for order stats, then processes users in
 * batches. No N+1 Order queries.
 */
export async function bulkEvaluateAllUserTiers(): Promise<{
  processed: number;
  errors: number;
}> {
  const BATCH_SIZE = 100;
  const APP_IDS: Array<Exclude<AppId, 'admin_panel'>> = ['manasik', 'ghadaq'];

  const [tiers, allUserStats] = await Promise.all([
    UserTier.find().sort({ baseAmount: -1 }).lean(),
    getAllUserStats(),
  ]);

  let processed = 0;
  let errors = 0;

  for (const appId of APP_IDS) {
    const UserModel = getUserModelByAppId(appId);
    const total = await (UserModel as unknown as { countDocuments: () => Promise<number> }).countDocuments();
    let skip = 0;

    while (skip < total) {
      const users = await (UserModel as unknown as { find: () => { select: (f: string) => { skip: (n: number) => { limit: (n: number) => { lean: () => Promise<Array<{ _id: unknown }>> } } } } }).find()
        .select('_id')
        .skip(skip)
        .limit(BATCH_SIZE)
        .lean();

      const updates = users.map((user) => {
        const userId = String(user._id);
        const stats = allUserStats.get(userId) ?? { spending: {}, orderCount: 0 };
        const bestTier = pickBestTier(stats, tiers);
        return {
          updateOne: {
            filter: { _id: userId },
            update: { $set: { tier: bestTier ? String(bestTier._id) : null } },
          },
        };
      });

      if (updates.length > 0) {
        try {
          await (UserModel as unknown as { bulkWrite: (ops: unknown[]) => Promise<unknown> }).bulkWrite(updates);
          processed += updates.length;
        } catch {
          errors += updates.length;
        }
      }

      skip += BATCH_SIZE;
    }
  }

  return { processed, errors };
}
