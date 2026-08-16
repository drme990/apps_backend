import mongoose from 'mongoose';
import Order from '../lib/models/Order';
import { allocateExecutionNumber, getOrderExecutionDate } from '../lib/services/execution-number';

// MongoDB connection string resolution order:
// 1. First non-option command-line argument (e.g. tsx script.ts --apply MONGOURI)
// 2. DATA_BASE_URL env var
// 3. MONGODB_URI env var
// 4. localhost fallback
const cliUri = process.argv.find(
  (arg) => arg.startsWith('mongodb://') || arg.startsWith('mongodb+srv://'),
);
const MONGODB_URI =
  cliUri ||
  process.env.DATA_BASE_URL ||
  process.env.MONGODB_URI ||
  'mongodb+srv://manasik-new:50TqqpcXYArAI7nO@manasik.aclzyuu.mongodb.net/manasik';

type BackfillOrder = {
  _id: mongoose.Types.ObjectId;
  reservationData?: Array<{ key: string; value: string }>;
  status?: string;
  createdAt?: Date;
};

const CONCURRENCY = 20;

async function main() {
  console.log('Starting executionNumber backfill...');
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
  console.log('✓ Connected to MongoDB');

  // Only backfill payable orders (paid / partial-paid) that already have an
  // executionDate set. This matches the pre-save hook logic.
  const query = {
    executionNumber: { $exists: false },
    status: { $in: ['paid', 'partial-paid'] as string[] },
    reservationData: {
      $elemMatch: {
        key: 'executionDate',
        value: { $regex: /^\d{4}-\d{2}-\d{2}$/ },
      },
    },
  };

  const missingCount = await Order.countDocuments(query);
  console.log(`Found ${missingCount} orders missing executionNumber.`);

  if (!process.argv.includes('--apply')) {
    console.log('Dry run only. Re-run with --apply to update the database.');
    await mongoose.connection.close();
    return;
  }

  // Sort by createdAt (asc) so the oldest order on each date gets #1.
  const cursor = Order.find(query)
    .select('_id reservationData status createdAt')
    .sort({ createdAt: 1 })
    .lean<BackfillOrder>()
    .cursor();

  let scanned = 0;
  let updated = 0;
  let pending: Promise<void>[] = [];

  for await (const order of cursor) {
    scanned += 1;

    const executionDate = getOrderExecutionDate(order);
    if (!executionDate) continue;

    const task = (async () => {
      try {
        // Use the atomic counter so this stays safe even if new paid orders
        // are created while the backfill is running.
        const executionNumber = await allocateExecutionNumber(executionDate);

        const result = await Order.updateOne(
          { _id: order._id, executionNumber: { $exists: false } },
          { $set: { executionNumber } },
        );

        if (result.modifiedCount > 0) {
          updated += 1;
        }
      } catch (error) {
        console.error(`[backfill] Failed for order ${order._id}:`, error);
      }
    })();

    pending.push(task);

    if (pending.length >= CONCURRENCY) {
      await Promise.all(pending);
      console.log(`Processed ${scanned} / ${missingCount} orders...`);
      pending = [];
    }
  }

  if (pending.length > 0) {
    await Promise.all(pending);
  }

  console.log('====================================');
  console.log(`Scanned : ${scanned}`);
  console.log(`Updated : ${updated}`);
  console.log('====================================');

  await mongoose.connection.close();
  console.log('✓ MongoDB connection closed');
}

main()
  .catch((error) => {
    console.error('Failed to backfill execution numbers:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await mongoose.connection.close();
    } catch {
      // ignore
    }
  });
