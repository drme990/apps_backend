import mongoose from 'mongoose';
import { connectDB } from '../lib/db';
import Order from '../lib/models/Order';
import { getUserModelByAppId } from '../lib/auth/app-users';

type AppId = 'manasik' | 'ghadaq';

async function migrateDefaultRefs() {
  console.log('Starting default ref migration...\n');

  try {
    await connectDB();
    console.log('✓ Connected to MongoDB\n');

    const apps: AppId[] = ['manasik', 'ghadaq'];

    let usersUpdated = 0;

    for (const appId of apps) {
      const UserModel = getUserModelByAppId(appId);

      console.log(`Processing users for ${appId}...`);

      const result1 = await UserModel.updateMany(
         { ref: 'default-GHD' } as any,
        { $set: { ref: 'GHD-D' } },
      );

      const result2 = await UserModel.updateMany(
        { ref: 'default-MNK' } as any,
        { $set: { ref: 'MNK-D' } },
      );

      usersUpdated +=
        (result1.modifiedCount || 0) +
        (result2.modifiedCount || 0);

      console.log(
        `Updated ${
          (result1.modifiedCount || 0) +
          (result2.modifiedCount || 0)
        } users`,
      );
    }

    console.log('\nProcessing orders...');

    const ordersGHD = await Order.updateMany(
      { referralId: 'default-GHD' },
      { $set: { referralId: 'GHD-D' } },
    );

    const ordersMNK = await Order.updateMany(
      { referralId: 'default-MNK' },
      { $set: { referralId: 'MNK-D' } },
    );

    const ordersUpdated =
      (ordersGHD.modifiedCount || 0) +
      (ordersMNK.modifiedCount || 0);

    console.log('\n====================================');
    console.log('Migration Summary');
    console.log('====================================');
    console.log(`Users updated  : ${usersUpdated}`);
    console.log(`Orders updated : ${ordersUpdated}`);
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

migrateDefaultRefs();