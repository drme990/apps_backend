/**
 * Script: Find orders whose `billingData` is missing phone / country /
 * email.
 *
 * Default: lists every order missing AT LEAST ONE of the three fields
 * and prints a per-order breakdown of which fields are missing.
 *
 * A field counts as "missing" when it is absent, null, or an
 * empty/whitespace-only string.
 *
 * Usage:
 *   npx tsx scripts/find-orders-missing-billing-fields.ts
 *   npx tsx scripts/find-orders-missing-billing-fields.ts --uri=mongodb://...
 *
 * Flags:
 *   --all           Only orders missing ALL THREE fields
 *   --month=YYYY-MM Only orders created in that month (default: current
 *                   month). Pass --month=all to scan every order.
 *   --uri=URI       MongoDB connection string (overrides .env / DATA_BASE_URL)
 *   --json=FILE     Also write the matching orders to a JSON file
 *                   (orderNumber, _id, source, createdAt, missingFields)
 *   --fix           Backfill missing billing fields from the linked
 *                   user account (users_manasik / users_ghadaq via
 *                   order.userId). Only EMPTY fields are filled —
 *                   existing values are never overwritten. Orders
 *                   still missing fields afterwards are reported.
 *   --dry-run       With --fix: print what WOULD be filled without
 *                   writing to the database.
 */

import mongoose, { Document, Types } from 'mongoose';
import { writeFileSync } from 'node:fs';

declare function require(name: string): unknown;
const fs = require('fs');
const path = require('path');

declare const process: {
  env: Record<string, string | undefined>;
  cwd: () => string;
  argv: string[];
  exit: (code?: number) => never;
  exitCode?: number;
};

const onlyMissingAll = process.argv.includes('--all');
const fixMode = process.argv.includes('--fix');
const dryRun = process.argv.includes('--dry-run');
const jsonArg = process.argv.find((a) => a.startsWith('--json='));
const jsonFile = jsonArg ? jsonArg.slice('--json='.length) : null;

// ── Month filter: default = current month ──
function getMonthRange(): { from: Date; to: Date } | null {
  const monthArg = process.argv.find((a) => a.startsWith('--month='));
  const value = monthArg ? monthArg.slice('--month='.length).trim() : '';

  if (value === 'all') return null;

  let year: number;
  let month: number; // 0-based

  if (value) {
    const match = /^(\d{4})-(\d{1,2})$/.exec(value);
    if (!match) {
      console.error(`Invalid --month value "${value}". Expected YYYY-MM (e.g. 2026-09) or "all".`);
      process.exit(1);
    }
    year = parseInt(match[1], 10);
    month = parseInt(match[2], 10) - 1;
    if (month < 0 || month > 11) {
      console.error(`Invalid --month value "${value}". Month must be 01-12.`);
      process.exit(1);
    }
  } else {
    const now = new Date();
    year = now.getFullYear();
    month = now.getMonth();
  }

  return {
    from: new Date(year, month, 1),
    to: new Date(year, month + 1, 1),
  };
}

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

  return process.env.DATA_BASE_URL || 'mongodb+srv://manasik-new:50TqqpcXYArAI7nO@manasik.aclzyuu.mongodb.net/manasik';
}

const isMissing = (v: unknown): boolean =>
  typeof v !== 'string' || v.trim().length === 0;

type OrderDoc = Document & {
  _id: Types.ObjectId;
  orderNumber?: string;
  source?: string;
  status?: string;
  createdAt?: Date;
  userId?: Types.ObjectId | string;
  billingData?: {
    fullName?: string;
    phone?: string;
    country?: string;
    email?: string;
  };
};

const OrderSchema = new mongoose.Schema(
  {
    orderNumber: String,
    source: String,
    status: String,
    createdAt: Date,
    userId: mongoose.Schema.Types.ObjectId,
    billingData: {
      fullName: String,
      phone: String,
      country: String,
      email: String,
    },
  },
  { strict: false },
);

const Order = mongoose.model<OrderDoc>(
  'MissingBillingOrder',
  OrderSchema,
  'orders',
);

// Minimal user model for the --fix backfill. The order's `source`
// decides which collection holds its customer account.
const AppUserSchema = new mongoose.Schema(
  {
    name: String,
    email: String,
    phone: String,
    country: String,
  },
  { strict: false },
);

const AppUserManasik = mongoose.model(
  'MissingBillingUserManasik',
  AppUserSchema,
  'users_manasik',
);
const AppUserGhadaq = mongoose.model(
  'MissingBillingUserGhadaq',
  AppUserSchema,
  'users_ghadaq',
);

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

    const monthRange = getMonthRange();
    if (monthRange) {
      console.log(
        `Scanning orders created in ${monthRange.from.toISOString().slice(0, 7)} ` +
        `(${monthRange.from.toISOString().slice(0, 10)} → ${monthRange.to.toISOString().slice(0, 10)})`,
      );
    } else {
      console.log('Scanning orders from ALL months (--month=all)');
    }

    // Missing any of phone / country / email. Empty-string-safe via
    // $or on each field: absent, null, or '' — whitespace-only values
    // are caught in the post-filter below.
    const orders = await Order.find(
      {
        ...(monthRange
          ? { createdAt: { $gte: monthRange.from, $lt: monthRange.to } }
          : {}),
        $or: [
          { 'billingData.phone': { $in: [null, ''] } },
          { 'billingData.phone': { $exists: false } },
          { 'billingData.country': { $in: [null, ''] } },
          { 'billingData.country': { $exists: false } },
          { 'billingData.email': { $in: [null, ''] } },
          { 'billingData.email': { $exists: false } },
        ],
      },
      {
        orderNumber: 1,
        source: 1,
        status: 1,
        createdAt: 1,
        userId: 1,
        billingData: 1,
      },
    )
      .sort({ createdAt: -1 })
      .allowDiskUse(true)
      .lean();

    const rows = orders
      .map((order) => {
        const billing = order.billingData || {};
        const missingFields = [
          isMissing(billing.phone) && 'phone',
          isMissing(billing.country) && 'country',
          isMissing(billing.email) && 'email',
        ].filter(Boolean) as string[];
        return {
          _id: String(order._id),
          orderNumber: order.orderNumber,
          source: order.source,
          status: order.status,
          createdAt: order.createdAt,
          userId: order.userId ? String(order.userId) : undefined,
          fullName: billing.fullName,
          missingFields,
        };
      })
      .filter((r) => r.missingFields.length > 0);

    const filtered = onlyMissingAll
      ? rows.filter((r) => r.missingFields.length === 3)
      : rows;

    // ── Summary ──
    const missingPhone = rows.filter((r) => r.missingFields.includes('phone')).length;
    const missingCountry = rows.filter((r) => r.missingFields.includes('country')).length;
    const missingEmail = rows.filter((r) => r.missingFields.includes('email')).length;
    const missingAllCount = rows.filter((r) => r.missingFields.length === 3).length;

    console.log(`\nOrders missing ≥1 billing field: ${rows.length}`);
    console.log(`  - missing phone:   ${missingPhone}`);
    console.log(`  - missing country: ${missingCountry}`);
    console.log(`  - missing email:   ${missingEmail}`);
    console.log(`  - missing all 3:   ${missingAllCount}`);
    if (onlyMissingAll) {
      console.log(`\n(--all: showing only orders missing all three)`);
    }
    console.log('');

    // ── Detail list ──
    for (const row of filtered) {
      const date = row.createdAt
        ? new Date(row.createdAt).toISOString().slice(0, 10)
        : '-';
      console.log(
        `${row.orderNumber ?? row._id}  [${row.source ?? '-'}]  ${date}  ${row.status ?? '-'}  missing: ${row.missingFields.join(', ')}  name: ${row.fullName ?? '-'}`,
      );
    }
    console.log(`\nListed ${filtered.length} order(s).`);

    // ── --fix: backfill missing fields from the linked user account ──
    if (fixMode) {
      console.log(
        `\n── Fix mode ${dryRun ? '(DRY RUN — no writes)' : ''} ──────────────`,
      );

      let fullyFixed = 0;
      let partiallyFixed = 0;
      let noUserData = 0;

      for (const row of filtered) {
        if (!row.userId || !mongoose.isValidObjectId(row.userId)) {
          console.log(
            `${row.orderNumber ?? row._id}  SKIP — no linked user account`,
          );
          noUserData += 1;
          continue;
        }

        const UserModel =
          row.source === 'ghadaq' ? AppUserGhadaq : AppUserManasik;
        const user = await UserModel.findById(row.userId)
          .select('name email phone country')
          .lean();

        if (!user) {
          console.log(
            `${row.orderNumber ?? row._id}  SKIP — user ${row.userId} not found in users_${row.source === 'ghadaq' ? 'ghadaq' : 'manasik'}`,
          );
          noUserData += 1;
          continue;
        }

        // Map missing billing fields → user fields
        const fill: Record<string, string> = {};
        for (const field of row.missingFields) {
          const userValue =
            field === 'email'
              ? user.email
              : field === 'phone'
                ? user.phone
                : field === 'country'
                  ? user.country
                  : undefined;
          if (typeof userValue === 'string' && userValue.trim()) {
            fill[`billingData.${field}`] = userValue.trim();
          }
        }

        const unfilled = row.missingFields.filter(
          (f) => !fill[`billingData.${f}`],
        );

        if (Object.keys(fill).length === 0) {
          console.log(
            `${row.orderNumber ?? row._id}  SKIP — user account also missing: ${row.missingFields.join(', ')}`,
          );
          noUserData += 1;
          continue;
        }

        if (!dryRun) {
          await Order.updateOne({ _id: row._id }, { $set: fill });
        }

        const filledList = Object.keys(fill)
          .map((k) => k.replace('billingData.', ''))
          .join(', ');
        if (unfilled.length === 0) {
          fullyFixed += 1;
          console.log(
            `${row.orderNumber ?? row._id}  ${dryRun ? 'WOULD FIX' : 'FIXED'} — filled: ${filledList}`,
          );
        } else {
          partiallyFixed += 1;
          console.log(
            `${row.orderNumber ?? row._id}  ${dryRun ? 'WOULD PARTIALLY FIX' : 'PARTIALLY FIXED'} — filled: ${filledList} | still missing: ${unfilled.join(', ')}`,
          );
        }
      }

      console.log('\n── Fix summary ──');
      console.log(`  Fully fixed:     ${fullyFixed}`);
      console.log(`  Partially fixed: ${partiallyFixed}`);
      console.log(`  No user data:    ${noUserData}`);
      if (dryRun) {
        console.log('  (dry run — nothing was written)');
      }
      if (partiallyFixed > 0 || noUserData > 0) {
        console.log(
          '\nRemaining orders need manual billing updates via the admin API (PATCH /api/admin/orders/{id} with billingData).',
        );
      }
    }

    if (jsonFile) {
      writeFileSync(jsonFile, JSON.stringify(filtered, null, 2));
      console.log(`Wrote ${filtered.length} record(s) to ${jsonFile}`);
    }

    process.exit(0);
  } catch (error) {
    console.error('Script failed:', error);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
  }
}

run();
