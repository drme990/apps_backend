import mongoose from 'mongoose';
import { connectDB } from '../lib/db';
import Order from '../lib/models/Order';
import { getUserModelByAppId } from '../lib/auth/app-users';

type AppId = 'manasik' | 'ghadaq';

type BackfillUser = {
  _id: mongoose.Types.ObjectId;
  email?: string;
};

type BackfillUserModel = {
  find(filter: Record<string, unknown>): {
    cursor(): AsyncIterable<BackfillUser>;
  };
  updateOne(
    filter: Record<string, unknown>,
    update: { $set: { ref: string } },
  ): Promise<unknown>;
};

/**
 * Backfill user.ref from the OLDEST order
 * that contains a valid referralId, falling back to the app default.
 */
async function migrateUserRefs() {
  console.log('Starting user referral backfill migration...\n');

  try {
    await connectDB();
    console.log('✓ Connected to MongoDB\n');

    const apps: AppId[] = ['manasik', 'ghadaq'];

    let totalScanned = 0;
    let totalUpdated = 0;
    for (const appId of apps) {
      console.log(`\n====================================`);
      console.log(`Processing app: ${appId}`);
      console.log(`====================================\n`);

      const UserModel = getUserModelByAppId(
        appId,
      ) as unknown as BackfillUserModel;

      // Users that don't already have ref
      const usersCursor = UserModel.find({
        $or: [{ ref: { $exists: false } }, { ref: null }, { ref: '' }],
      }).cursor();

      for await (const user of usersCursor) {
        totalScanned++;

        console.log(`[${totalScanned}] Checking ${user.email || user._id}...`);

        /**
         * Load ALL orders oldest -> newest
         * Then pick the FIRST valid referralId
         */
        const orders = await Order.find({
          userId: user._id,
        })
          .sort({ createdAt: 1 }) // OLDEST FIRST
          .select('referralId createdAt')
          .lean();

        let oldestReferralCode: string | null = null;

        for (const order of orders) {
          const referralId = order?.referralId;

          if (typeof referralId === 'string' && referralId.trim() !== '') {
            oldestReferralCode = referralId.trim();
            break; // FIRST valid referral from oldest orders
          }
        }

        if (!oldestReferralCode) {
          oldestReferralCode =
            appId === 'ghadaq' ? 'default-GHD' : 'default-MNK';
        }

        await UserModel.updateOne(
          { _id: user._id },
          {
            $set: {
              ref: oldestReferralCode,
            },
          },
        );

        totalUpdated++;

        console.log(`Updated with ref: ${oldestReferralCode} ✅`);
      }
    }

    console.log('\n====================================');
    console.log('Migration Summary');
    console.log('====================================');
    console.log(`Users scanned : ${totalScanned}`);
    console.log(`Users updated : ${totalUpdated}`);
    console.log('====================================\n');

    console.log('✓ Migration completed successfully!');
  } catch (error) {
    console.error('\n✗ Migration failed:\n', error);
    throw error;
  } finally {
    await mongoose.connection.close();
    console.log('\n✓ MongoDB connection closed');
  }
}

// Run migration
migrateUserRefs();
