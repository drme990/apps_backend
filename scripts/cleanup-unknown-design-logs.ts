/**
 * Script: Delete all design generation logs with orderNumber "unknown".
 *
 * These logs are created when triggerAutoDesignGeneration or
 * triggerDesignRegeneration is called for an order that doesn't exist
 * (e.g. the order was deleted, or the orderId was invalid). They show
 * up as "unknown" in the admin panel's design logs page and are noise.
 *
 * Usage:
 *   npx tsx scripts/cleanup-unknown-design-logs.ts
 */

import mongoose from 'mongoose';
import { connectDB } from '../lib/db';
import OrderDesignLog from '../lib/models/OrderDesignLog';

async function cleanupUnknownLogs() {
  await connectDB();

  const result = await OrderDesignLog.deleteMany({ orderNumber: 'unknown' });

  console.log(
    `Deleted ${result.deletedCount} design log(s) with orderNumber "unknown".`,
  );
}

cleanupUnknownLogs()
  .catch((error) => {
    console.error('Failed to cleanup unknown design logs:', error);
    throw error;
  })
  .finally(async () => {
    await mongoose.connection.close();
  });
