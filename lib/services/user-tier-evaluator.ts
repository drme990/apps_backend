/**
 * User Tier Evaluation Service
 *
 * Evaluates which tier a user belongs to based on their lifetime paid spending
 * across all their orders (both sources: manasik, ghadaq).
 *
 * Tiers are sorted by sortOrder ASC. The highest tier the user qualifies for
 * (i.e., their spending meets the tier's minimumAmount for their order currency)
 * is assigned.
 *
 * "Qualifies" means: for each order, we look up the tier's minimumAmount for
 * that order's currency. If the user's total spending in that currency meets or
 * exceeds the threshold, they qualify.
 *
 * Because users can have orders in multiple currencies, we use the following
 * strategy: for each tier, we check if the user's total spending in ANY single
 * currency meets or exceeds the tier's threshold for that currency.
 */

import Order from '@/lib/models/Order';
import UserTier, { IUserTier } from '@/lib/models/UserTier';
import { getUserModelByAppId, type AppId } from '@/lib/auth/app-users';

type SpendingMap = Record<string, number>;

/**
 * Returns lifetime paid spending per currency for a user across all sources.
 */
async function getUserLifetimeSpending(userId: string): Promise<SpendingMap> {
  const paidStatuses = ['paid', 'partial-paid', 'completed'];

  const orders = await Order.find({
    userId,
    status: { $in: paidStatuses },
    isGuest: false,
  })
    .select('paidAmount totalAmount currency')
    .lean();

  const spending: SpendingMap = {};

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
  }

  return spending;
}

/**
 * Determines the best tier for a user given their spending map and a list of tiers.
 * Tiers must be sorted by baseAmount DESC (highest threshold first).
 * The FIRST qualifying tier is the highest (best) one the user qualifies for.
 * Returns the best qualifying tier, or null if none qualify.
 */
function pickBestTier(
  spending: SpendingMap,
  tiers: IUserTier[],
): IUserTier | null {
  for (const tier of tiers) {
    for (const minAmount of tier.minimumAmounts) {
      const currency = minAmount.currencyCode.toUpperCase();
      const userSpent = spending[currency] || 0;

      if (userSpent >= minAmount.amount) {
        return tier;
      }
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
    const [tiers, spending] = await Promise.all([
      UserTier.find().sort({ baseAmount: -1 }).lean(),
      getUserLifetimeSpending(userId),
    ]);

    const bestTier = pickBestTier(spending, tiers);

    const UserModel = getUserModelByAppId(appId);
    await (UserModel as any).findByIdAndUpdate(userId, {
      $set: { tier: bestTier ? String(bestTier._id) : null },
    });
  } catch (error) {
    console.error(
      `[UserTierEvaluator] Failed to evaluate tier for user ${userId}:`,
      error,
    );
  }
}

/**
 * Bulk-evaluates and updates tiers for ALL users across all sources.
 * Used when admin saves/edits/deletes a tier and clicks "Apply".
 * Processes in batches to avoid memory issues.
 */
export async function bulkEvaluateAllUserTiers(): Promise<{
  processed: number;
  errors: number;
}> {
  const BATCH_SIZE = 100;
  const APP_IDS: Array<Exclude<AppId, 'admin_panel'>> = ['manasik', 'ghadaq'];

  const tiers = await UserTier.find().sort({ baseAmount: -1 }).lean();

  let processed = 0;
  let errors = 0;

  for (const appId of APP_IDS) {
    const UserModel = getUserModelByAppId(appId);
    const total = await (UserModel as any).countDocuments();
    let skip = 0;

    while (skip < total) {
      const users = await (UserModel as any)
        .find()
        .select('_id')
        .skip(skip)
        .limit(BATCH_SIZE)
        .lean();

      await Promise.all(
        users.map(async (user: { _id: unknown }) => {
          const userId = String(user._id);
          try {
            const spending = await getUserLifetimeSpending(userId);
            const bestTier = pickBestTier(spending, tiers);
            await (UserModel as any).findByIdAndUpdate(userId, {
              $set: { tier: bestTier ? String(bestTier._id) : null },
            });
            processed++;
          } catch {
            errors++;
          }
        }),
      );

      skip += BATCH_SIZE;
    }
  }

  return { processed, errors };
}
