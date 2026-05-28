import mongoose from 'mongoose';
import { connectDB } from '../lib/db';
import Order from '../lib/models/Order';

type BackfillOrder = {
  _id: mongoose.Types.ObjectId;
  updatedAt?: Date;
  createdAt?: Date;
};

async function main() {
  console.log('Starting statusUpdateTime backfill...');

  await connectDB();
  console.log('✓ Connected to MongoDB');

  const query = {
    $or: [{ statusUpdateTime: { $exists: false } }, { statusUpdateTime: null }],
  };

  const missingCount = await Order.countDocuments(query);
  console.log(`Found ${missingCount} orders missing statusUpdateTime.`);

  if (!process.argv.includes('--apply')) {
    console.log('Dry run only. Re-run with --apply to update the database.');
    await mongoose.connection.close();
    return;
  }

  let scanned = 0;
  let updated = 0;
  const batchSize = 500;
  let operations: Array<{
    updateOne: {
      filter: { _id: mongoose.Types.ObjectId };
      update: { $set: { statusUpdateTime: Date } };
    };
  }> = [];

  const cursor = Order.find(query)
    .select('_id updatedAt createdAt')
    .lean<BackfillOrder>()
    .cursor();

  for await (const order of cursor) {
    scanned += 1;

    operations.push({
      updateOne: {
        filter: { _id: order._id },
        update: {
          $set: {
            statusUpdateTime: order.updatedAt || order.createdAt || new Date(),
          },
        },
      },
    });

    if (operations.length >= batchSize) {
      const result = await Order.bulkWrite(operations, { ordered: false });
      updated += result.modifiedCount;
      console.log(`Processed ${scanned} / ${missingCount} orders...`);
      operations = [];
    }
  }

  if (operations.length > 0) {
    const result = await Order.bulkWrite(operations, { ordered: false });
    updated += result.modifiedCount;
  }

  console.log('====================================');
  console.log(`Scanned : ${scanned}`);
  console.log(`Updated : ${updated}`);
  console.log('====================================');

  await mongoose.connection.close();
  console.log('✓ MongoDB connection closed');
}

main().catch((error) => {
  console.error('Failed to backfill order statusUpdateTime:', error);
  process.exitCode = 1;
});
