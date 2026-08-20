/**
 * Migration script: normalize items.productId from string to ObjectId
 *
 * PROBLEM:
 *   The Order schema defines items.productId as Mixed type. Some orders
 *   store it as a string (e.g. "6990d11be7e7406607017569") while others
 *   store it as an ObjectId. MongoDB does NOT coerce between strings and
 *   ObjectIds in $in/$nin aggregation operators, so orders with string
 *   product IDs never matched category filters — they always appeared as
 *   "uncategorized" even when their product was in a category.
 *
 * FIX:
 *   This script converts all string-typed items.productId values to
 *   ObjectId. It skips:
 *   - Items where productId is already an ObjectId
 *   - Items where productId is a non-ObjectId string (e.g. "__manual_order__")
 *
 * USAGE:
 *   npx tsx scripts/migrate-order-product-id-to-objectid.ts
 *   npx tsx scripts/migrate-order-product-id-to-objectid.ts --uri=mongodb://...
 *   npx tsx scripts/migrate-order-product-id-to-objectid.ts --dry-run
 */
import mongoose from 'mongoose';

declare function require(name: string): unknown;
const fs = require('fs');
const path = require('path');

declare const process: {
  env: Record<string, string | undefined>;
  cwd: () => string;
  argv: string[];
  exit: (code?: number) => never;
};

function loadEnvFile(filePath: string) {
  if (!fs.existsSync(filePath)) return;

  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const separatorIndex = line.indexOf('=');
    if (separatorIndex <= 0) continue;

    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

function loadEnvFiles() {
  const cwd = process.cwd();
  loadEnvFile(path.join(cwd, '.env'));
  loadEnvFile(path.join(cwd, '.env.local'));
}

function getMongoUri(): string {
  const cliUriArg = process.argv.find((arg) => arg.startsWith('--uri='));
  if (cliUriArg) {
    return cliUriArg.slice('--uri='.length);
  }

  return process.env.DATA_BASE_URL || 'mongodb://localhost:27017/manasik';
}

function isDryRun(): boolean {
  return process.argv.includes('--dry-run');
}

/**
 * Check if a string is a valid 24-char hex ObjectId.
 */
function isValidObjectIdString(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  return /^[0-9a-fA-F]{24}$/.test(value);
}

const OrderSchema = new mongoose.Schema(
  {
    items: [
      {
        productId: mongoose.Schema.Types.Mixed,
        productSlug: String,
        productName: { ar: String, en: String },
      },
    ],
  },
  { strict: false },
);

type OrderDoc = mongoose.Document & {
  _id: mongoose.Types.ObjectId;
  items: Array<{
    productId?: unknown;
    productSlug?: string;
    productName?: { ar: string; en: string };
  }>;
};

const Order =
  (mongoose.models.Order as mongoose.Model<OrderDoc>) ||
  mongoose.model<OrderDoc>('Order', OrderSchema, 'orders');

async function run() {
  try {
    loadEnvFiles();

    const mongoUri = getMongoUri();
    const dryRun = isDryRun();

    await mongoose.connect(mongoUri);
    const connection = mongoose.connection;
    console.log('Connected to MongoDB');
    if (mongoUri.includes('localhost')) {
      console.warn(
        'Warning: using localhost database. Pass --uri=... to target a different database.',
      );
    }
    console.log(
      `Database: ${connection.name || 'unknown'}${connection.host ? ` (${connection.host})` : ''}`,
    );
    console.log(`Mode: ${dryRun ? 'DRY RUN (no writes)' : 'LIVE (will update documents)'}`);
    console.log('');

    // Find all orders that have at least one item with a string productId
    // that looks like a valid ObjectId (24-char hex).
    const orders = await Order.find({
      'items.productId': { $type: 'string' },
    }).limit(0);

    console.log(`Found ${orders.length} order(s) with string-typed productId`);

    if (orders.length === 0) {
      console.log('Nothing to migrate. All productIds are already ObjectIds.');
      process.exit(0);
    }

    let updatedOrders = 0;
    let updatedItems = 0;
    let skippedItems = 0;

    for (const order of orders) {
      let changed = false;

      for (const item of order.items) {
        const pid = item.productId;

        // Already an ObjectId — skip
        if (mongoose.Types.ObjectId.isValid(pid) && typeof pid !== 'string') {
          continue;
        }

        // String that is a valid ObjectId hex — convert it
        if (isValidObjectIdString(pid)) {
          item.productId = new mongoose.Types.ObjectId(pid);
          changed = true;
          updatedItems += 1;
        } else {
          // Non-ObjectId string (e.g. "__manual_order__") — leave as-is
          skippedItems += 1;
        }
      }

      if (changed) {
        updatedOrders += 1;
        if (!dryRun) {
          await order.save();
        }
      }
    }

    console.log('');
    console.log('=== Migration Summary ===');
    console.log(`Orders scanned:    ${orders.length}`);
    console.log(`Orders updated:    ${updatedOrders}`);
    console.log(`Items converted:   ${updatedItems}`);
    console.log(`Items skipped:     ${skippedItems} (non-ObjectId strings like '__manual_order__')`);
    console.log(`Mode:              ${dryRun ? 'DRY RUN (no writes)' : 'LIVE'}`);
    console.log('');
    console.log('Migration completed successfully');

    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
  }
}

run();
