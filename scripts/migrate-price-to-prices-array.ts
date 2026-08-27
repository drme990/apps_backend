/**
 * Migration script: Copy size.price into prices[] as the baseCurrency entry.
 *
 * With the refactored pricing model, `prices[]` is the single source of truth.
 * The base-currency price lives as an entry in `prices[]` with
 * `currencyCode === product.baseCurrency`. The deprecated `size.price` field
 * is kept in the DB for backward compatibility but is no longer used by
 * new code.
 *
 * This script ensures every product has a base-currency entry in `prices[]`
 * by copying from `size.price` if the entry is missing.
 *
 * Usage:
 *   npx tsx scripts/migrate-price-to-prices-array.ts
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

type ProductDoc = mongoose.Document & {
  _id: mongoose.Types.ObjectId;
  baseCurrency: string;
  sizes: ProductSize[];
};

async function migrate() {
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
    process.env.MONGODB_URI || process.env.MONGO_URI || 'mongodb://localhost:27017/manasik';

  console.log(`Connecting to MongoDB: ${mongoUri.replace(/\/\/[^@]*@/, '//***:***@')}`);
  await mongoose.connect(mongoUri);
  console.log('Connected.\n');

  const db = mongoose.connection.db;
  if (!db) {
    console.error('Could not get database instance');
    process.exit(1);
  }

  const collection = db.collection('products');
  const products = (await collection.find({}).toArray()) as unknown as Array<{
    _id: mongoose.Types.ObjectId;
    baseCurrency: string;
    sizes: ProductSize[];
  }>;

  console.log(`Found ${products.length} products to check.`);

  let migratedCount = 0;
  let skippedCount = 0;

  for (const product of products) {
    const baseCurrency = (product.baseCurrency || 'SAR').toUpperCase();
    let modified = false;

    if (!product.sizes || !Array.isArray(product.sizes)) continue;

    for (const size of product.sizes) {
      if (!size.prices || !Array.isArray(size.prices)) {
        size.prices = [];
      }

      const existingIdx = size.prices.findIndex(
        (p) => p.currencyCode.toUpperCase() === baseCurrency,
      );

      if (existingIdx >= 0) {
        // Already has base currency entry — skip
        continue;
      }

      // No base currency entry — copy from size.price
      const basePrice = size.price ?? 0;
      if (basePrice > 0) {
        size.prices.push({
          currencyCode: baseCurrency,
          amount: basePrice,
          isManual: true,
        });
        modified = true;
      }
    }

    if (modified) {
      await collection.updateOne(
        { _id: product._id },
        { $set: { sizes: product.sizes } },
      );
      migratedCount++;
      console.log(`  ✓ Migrated product ${product._id} (${baseCurrency})`);
    } else {
      skippedCount++;
    }
  }

  console.log(`\nDone! Migrated: ${migratedCount}, Skipped (already had entry): ${skippedCount}`);
  await mongoose.disconnect();
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
