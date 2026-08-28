/**
 * Migration script: Remove the deprecated `size.price` field from all
 * products, keeping only the `prices[]` array as the single source of truth.
 *
 * Steps (per product, per size):
 *   1. Ensure `prices[]` has a base-currency entry (currencyCode ===
 *      product.baseCurrency). If missing, copy from the deprecated
 *      `size.price` field (if > 0). This is the safety net — no data
 *      is lost.
 *   2. Remove the `price` field from all sizes via `$unset`.
 *
 * After running this script:
 *   - `size.price` is gone from the DB
 *   - `size.prices[]` always has a base-currency entry (if the product
 *     had a non-zero price before)
 *   - The cron job (`/api/cron/update-prices`) reads the base-currency
 *     entry from `prices[]` and converts to all target currencies
 *
 * Usage:
 *   npx tsx scripts/remove-price-field.ts          # live run
 *   npx tsx scripts/remove-price-field.ts --dry-run # preview only
 */

import mongoose from 'mongoose';

declare function require(name: string): unknown;
const fs = require('fs') as {
  existsSync: (filePath: string) => boolean;
  readFileSync: (filePath: string, encoding: string) => string;
};
const path = require('path') as {
  join: (...paths: string[]) => string;
};

declare const process: {
  env: Record<string, string | undefined>;
  cwd: () => string;
  argv: string[];
  exit: (code?: number) => never;
};

type CurrencyPrice = {
  currencyCode: string;
  amount: number;
  isManual: boolean;
};

type ProductSize = {
  price?: number;
  prices: CurrencyPrice[];
};

type ProductDoc = {
  _id: mongoose.Types.ObjectId;
  baseCurrency: string;
  sizes: ProductSize[];
};

async function migrate() {
  const isDryRun = process.argv.includes('--dry-run');

  // Load .env manually
  const envPath = path.join(process.cwd(), '.env');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    for (const line of envContent.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
      if (!(key in process.env)) {
        process.env[key] = value;
      }
    }
  }

  const mongoUri =
    process.env.MONGODB_URI ||
    process.env.MONGO_URI ||
    'mongodb://localhost:27017/manasik';

  console.log(`Connecting to MongoDB: ${mongoUri.replace(/\/\/[^@]*@/, '//***:***@')}`);
  console.log(`Mode: ${isDryRun ? 'DRY RUN (no changes)' : 'LIVE'}`);
  await mongoose.connect(mongoUri);
  console.log('Connected.\n');

  const db = mongoose.connection.db;
  if (!db) {
    console.error('Could not get database instance');
    process.exit(1);
  }

  const collection = db.collection('products');
  const products = (await collection.find({}).toArray()) as unknown as ProductDoc[];

  console.log(`Found ${products.length} products to process.\n`);

  let migratedCount = 0;
  let skippedCount = 0;
  let baseEntryAdded = 0;
  let priceFieldRemoved = 0;

  for (const product of products) {
    const baseCurrency = (product.baseCurrency || 'SAR').toUpperCase();

    if (!product.sizes || !Array.isArray(product.sizes)) continue;

    let needsBaseEntry = false;
    let modified = false;

    for (const size of product.sizes) {
      if (!size.prices || !Array.isArray(size.prices)) {
        size.prices = [];
      }

      const existingIdx = size.prices.findIndex(
        (p) => p.currencyCode.toUpperCase() === baseCurrency,
      );

      if (existingIdx < 0) {
        // No base currency entry — copy from deprecated size.price
        const basePrice = size.price ?? 0;
        if (basePrice > 0) {
          size.prices.push({
            currencyCode: baseCurrency,
            amount: basePrice,
            isManual: true,
          });
          needsBaseEntry = true;
          baseEntryAdded++;
          console.log(
            `  → Product ${product._id}: added ${baseCurrency} entry (${basePrice}) from size.price`,
          );
        } else {
          console.log(
            `  ⚠ Product ${product._id}: size has no base entry AND size.price is 0/missing — prices[] will be empty`,
          );
        }
      }

      // Remove the deprecated price field from the in-memory doc
      if (size.price !== undefined) {
        delete size.price;
        modified = true;
      }
    }

    if (isDryRun) {
      if (needsBaseEntry || modified) {
        console.log(
          `  [DRY] Would update product ${product._id}: baseEntryAdded=${needsBaseEntry}, priceRemoved=${modified}`,
        );
      }
      continue;
    }

    // Write back the updated sizes array. The `price` field has already
    // been removed from each size in-memory (via `delete size.price`
    // above), so $set replaces the entire sizes array — no $unset needed.
    // (MongoDB doesn't allow $set and $unset on the same path in one op.)
    if (needsBaseEntry || modified) {
      await collection.updateOne(
        { _id: product._id },
        { $set: { sizes: product.sizes } },
      );
      migratedCount++;
      if (modified) priceFieldRemoved++;
      console.log(`  ✓ Updated product ${product._id} (${baseCurrency})`);
    } else {
      skippedCount++;
    }
  }

  console.log(`\n── Summary ──`);
  console.log(`  Total products:   ${products.length}`);
  console.log(`  Updated:          ${migratedCount}`);
  console.log(`  Skipped (clean):  ${skippedCount}`);
  console.log(`  Base entries added: ${baseEntryAdded}`);
  console.log(`  Price fields removed: ${priceFieldRemoved}`);
  if (isDryRun) {
    console.log(`\n  (DRY RUN — no changes were made. Run without --dry-run to apply.)`);
  }

  await mongoose.disconnect();
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
