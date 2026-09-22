/**
 * Script: Normalize customer names to be EasyKash-safe.
 *
 * EasyKash validates the payment `name` field with
 * `onlyNumbersAndCharacters` — punctuation, symbols, emojis and
 * combining marks (Arabic tashkeel, accents) are rejected with a 460
 * error, which breaks checkout and remaining-payment links.
 *
 * This script normalizes names in-place across:
 *   1. users_manasik.name
 *   2. users_ghadaq.name
 *   3. orders.billingData.fullName   (the field actually sent to the gateway)
 *
 * `orders.reservationData` is intentionally NOT touched — those names
 * are meaningful content (deceased names rendered on designs) and the
 * gateway already receives a sanitized copy via
 * `sanitizeCustomerNameForGateway`.
 *
 * Usage:
 *   npx tsx scripts/normalize-user-names.ts            # apply
 *   npx tsx scripts/normalize-user-names.ts --dry-run  # preview only
 *   npx tsx scripts/normalize-user-names.ts --uri=mongodb://...
 */

import mongoose, { Document, Types } from 'mongoose';
import { sanitizeCustomerNameForGateway } from '../lib/utils/name';

declare function require(name: string): unknown;
const fs = require('fs') as {
  existsSync(filePath: string): boolean;
  readFileSync(filePath: string, encoding: string): string;
};
const path = require('path') as {
  join(...parts: string[]): string;
};

declare const process: {
  env: Record<string, string | undefined>;
  cwd: () => string;
  argv: string[];
  exit: (code?: number) => never;
};

const isDryRun = process.argv.includes('--dry-run');

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

type UserDoc = Document & {
  _id: Types.ObjectId;
  name?: string;
};

type OrderDoc = Document & {
  _id: Types.ObjectId;
  orderNumber?: string;
  billingData?: { fullName?: string };
};

const UserSchema = new mongoose.Schema(
  { name: String },
  { strict: false },
);

const OrderSchema = new mongoose.Schema(
  {
    orderNumber: String,
    billingData: { fullName: String },
  },
  { strict: false },
);

const UserManasik = mongoose.model<UserDoc>(
  'NormUserManasik',
  UserSchema,
  'users_manasik',
);
const UserGhadaq = mongoose.model<UserDoc>(
  'NormUserGhadaq',
  UserSchema,
  'users_ghadaq',
);
const Order = mongoose.model<OrderDoc>('NormOrder', OrderSchema, 'orders');

/**
 * Normalize every `name` in a user collection. Returns the number of
 * documents updated.
 *
 * Writes via updateOne with $set on the leaf path only — never rewrites
 * the whole document.
 */
async function normalizeUserCollection(
  label: string,
  model: mongoose.Model<UserDoc>,
): Promise<number> {
  const users = await model.find({ name: { $type: 'string' } }).lean();
  let updated = 0;

  for (const user of users) {
    const original = user.name || '';
    const normalized = sanitizeCustomerNameForGateway(original);

    if (normalized === original.trim() && original === original.trim()) {
      continue; // already clean
    }

    updated += 1;
    console.log(`  [${label}] "${original}" → "${normalized}"`);

    if (!isDryRun) {
      await model.updateOne(
        { _id: user._id },
        { $set: { name: normalized } },
      );
    }
  }

  console.log(
    `  ${label}: ${updated} of ${users.length} names ${isDryRun ? 'would be' : ''} normalized`,
  );
  return updated;
}

/**
 * Normalize `billingData.fullName` on all orders — this is the exact
 * field sent to EasyKash when generating payment links.
 *
 * IMPORTANT: writes via updateOne with $set on 'billingData.fullName'
 * ONLY. A previous version assigned `order.billingData = {...}` then
 * called `order.save()` — but the declared schema only knows `fullName`,
 * so `doc.billingData` exposed just that one key and save() overwrote
 * the whole object, wiping billingData.phone/.email/.country. Never
 * reintroduce a document-level save here.
 */
async function normalizeOrderNames(): Promise<number> {
  const orders = await Order.find({
    'billingData.fullName': { $type: 'string', $ne: '' },
  }).lean();
  let updated = 0;

  for (const order of orders) {
    const original = order.billingData?.fullName || '';
    const normalized = sanitizeCustomerNameForGateway(original);

    if (normalized === original.trim() && original === original.trim()) {
      continue;
    }

    updated += 1;
    console.log(
      `  [orders] ${order.orderNumber || order._id}: "${original}" → "${normalized}"`,
    );

    if (!isDryRun) {
      await Order.updateOne(
        { _id: order._id },
        { $set: { 'billingData.fullName': normalized } },
      );
    }
  }

  console.log(
    `  orders: ${updated} of ${orders.length} billing names ${isDryRun ? 'would be' : ''} normalized`,
  );
  return updated;
}

async function run() {
  try {
    loadEnvFiles();

    const mongoUri = getMongoUri();
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
    if (isDryRun) {
      console.log('DRY RUN — no changes will be written\n');
    }

    const usersUpdated =
      (await normalizeUserCollection('users_manasik', UserManasik)) +
      (await normalizeUserCollection('users_ghadaq', UserGhadaq));
    const ordersUpdated = await normalizeOrderNames();

    console.log(
      `\nDone. ${usersUpdated} user names, ${ordersUpdated} order billing names ${isDryRun ? 'would be' : ''} normalized.`,
    );

    process.exit(0);
  } catch (error) {
    console.error('Name normalization failed:', error);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
  }
}

run();
