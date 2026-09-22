/**
 * Script: Normalize every stored country value to the canonical English
 * long name ("EG" / "egypt" → "Egypt").
 *
 * Fields covered:
 *   orders.billingData.country          (user-chosen billing country)
 *   orders.location                     (geo-detected viewer country)
 *   users_manasik.country / .detectedCountry
 *   users_ghadaq.country  / .detectedCountry
 *   customerhistories.previousValue / .newValue  (type: 'country' only)
 *
 * Usage:
 *   npx tsx scripts/normalize-countries.ts                # apply
 *   npx tsx scripts/normalize-countries.ts --dry-run      # preview only
 *   npx tsx scripts/normalize-countries.ts --verbose      # per-document lines
 *   npx tsx scripts/normalize-countries.ts --uri=mongodb://...
 */

import mongoose from 'mongoose';
import {
  normalizeCountryName,
  normalizeCountryCode,
  countryNameToCode,
  countryCodeToName,
} from '../lib/country-visibility';

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
  stdout: { write(text: string): void };
  exit: (code?: number) => never;
};

const dryRun = process.argv.includes('--dry-run');
const verbose = process.argv.includes('--verbose');

function loadEnvFile(filePath: string) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const sep = line.indexOf('=');
    if (sep <= 0) continue;
    const key = line.slice(0, sep).trim();
    let value = line.slice(sep + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

function loadEnvFiles() {
  const cwd = process.cwd();
  loadEnvFile(path.join(cwd, '.env'));
  loadEnvFile(path.join(cwd, '.env.local'));
}

function getMongoUri(): string {
  const cli = process.argv.find((a) => a.startsWith('--uri='));
  if (cli) return cli.slice('--uri='.length);
  return (
    process.env.DATA_BASE_URL || 'mongodb://localhost:27017/manasik'
  );
}

// ── Per-collection field plan ──
// `path` values are Mongo dotted paths; `filter` narrows which docs in
// the collection are touched (e.g. only country-type history entries).
const TARGETS: Array<{
  collection: string;
  label: string;
  fields: string[];
  filter?: Record<string, unknown>;
}> = [
    {
      collection: 'orders',
      label: 'orders.billingData.country',
      fields: ['billingData.country'],
    },
    {
      collection: 'orders',
      label: 'orders.location',
      fields: ['location'],
    },
    {
      collection: 'users_manasik',
      label: 'users_manasik.country',
      fields: ['country'],
    },
    {
      collection: 'users_manasik',
      label: 'users_manasik.detectedCountry',
      fields: ['detectedCountry'],
    },
    {
      collection: 'users_ghadaq',
      label: 'users_ghadaq.country',
      fields: ['country'],
    },
    {
      collection: 'users_ghadaq',
      label: 'users_ghadaq.detectedCountry',
      fields: ['detectedCountry'],
    },
    {
      collection: 'customerhistories',
      label: 'customerhistories (country entries)',
      fields: ['previousValue', 'newValue'],
      filter: { type: 'country' },
    },
  ];

function getByPath(doc: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object') {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, doc);
}

interface CollectionResult {
  scanned: number;
  changed: number;
  skipped: number;
  /** "raw" → "normalized" occurrence counts across all fields */
  transitions: Map<string, number>;
  /** raw values that normalizeCountryName could not map (kept as-is) */
  unrecognizedValues: Map<string, number>;
}

async function normalizeCollection(
  target: (typeof TARGETS)[number],
): Promise<CollectionResult> {
  const coll = mongoose.connection.collection(target.collection);
  const or = target.fields.flatMap((f) => [
    { [f]: { $type: 'string' } },
  ]);

  const query: Record<string, unknown> = {
    ...(target.filter || {}),
    $or: or,
  };

  const cursor = coll.find(query);
  const result: CollectionResult = {
    scanned: 0,
    changed: 0,
    skipped: 0,
    transitions: new Map(),
    unrecognizedValues: new Map(),
  };
  const bulk: Array<{
    updateOne: {
      filter: Record<string, unknown>;
      update: Record<string, unknown>;
    };
  }> = [];

  for await (const doc of cursor) {
    result.scanned += 1;
    const set: Record<string, string> = {};
    let unrecognized = false;

    for (const field of target.fields) {
      const raw = getByPath(doc, field);
      if (typeof raw !== 'string' || !raw.trim()) continue;
      const normalized = normalizeCountryName(raw);
      // Compare against the untrimmed raw so values like ' Egypt '
      // also get cleaned, not just non-canonical spellings.
      if (normalized && normalized !== raw) {
        set[field] = normalized;
        const key = `"${raw.trim()}" → "${normalized}"`;
        result.transitions.set(key, (result.transitions.get(key) ?? 0) + 1);
      } else {
        // Unchanged — either already canonical or an unrecognized
        // passthrough value. Report the latter so they can be reviewed.
        // A value counts as recognized only when it resolves to a code
        // that exists in the canonical name map — this filters out
        // garbage 2-letter strings that countryNameToCode passes through.
        const trimmed = raw.trim();
        const code =
          normalizeCountryCode(trimmed) ?? countryNameToCode(trimmed);
        const recognized = code !== null && countryCodeToName(code) !== null;
        if (!recognized) {
          unrecognized = true;
          const key = `"${trimmed}"`;
          result.unrecognizedValues.set(
            key,
            (result.unrecognizedValues.get(key) ?? 0) + 1,
          );
        }
      }
    }

    if (Object.keys(set).length > 0) {
      result.changed += 1;
      if (verbose) {
        const preview = Object.entries(set)
          .map(([k, v]) => `${k}: "${getByPath(doc, k)}" → "${v}"`)
          .join(', ');
        if (result.changed <= 25) {
          console.log(`    ${doc._id}  ${preview}`);
        } else if (result.changed === 26) {
          console.log('    … (further changes suppressed)');
        }
      }
      if (!dryRun) {
        bulk.push({
          updateOne: { filter: { _id: doc._id }, update: { $set: set } },
        });
      }
    } else if (unrecognized) {
      result.skipped += 1;
    }
  }

  if (!dryRun && bulk.length > 0) {
    // bulkWrite in chunks of 500 to keep payload sizes sane
    for (let i = 0; i < bulk.length; i += 500) {
      await coll.bulkWrite(bulk.slice(i, i + 500), { ordered: false });
    }
  }

  return result;
}

async function run() {
  try {
    loadEnvFiles();
    const uri = getMongoUri();
    await mongoose.connect(uri);
    const conn = mongoose.connection;
    console.log(`Connected: ${conn.name || 'unknown'} (${conn.host || '?'})`);
    if (dryRun) console.log('DRY RUN — nothing will be written\n');

    let totalScanned = 0;
    let totalChanged = 0;
    let totalSkipped = 0;

    for (const target of TARGETS) {
      console.log(`\n${target.label}`);
      const r = await normalizeCollection(target);
      const verb = dryRun ? 'would change' : 'changed';
      console.log(
        `  scanned: ${r.scanned.toLocaleString()}   ${verb}: ${r.changed.toLocaleString()}` +
        (r.skipped ? `   unrecognized: ${r.skipped.toLocaleString()}` : ''),
      );

      // Grouped transformation breakdown, most frequent first
      const sorted = [...r.transitions.entries()].sort((a, b) => b[1] - a[1]);
      for (const [transition, count] of sorted) {
        console.log(`    ${transition.padEnd(46)} ${count.toLocaleString()}`);
      }

      if (r.unrecognizedValues.size > 0) {
        const sortedUnrec = [...r.unrecognizedValues.entries()].sort(
          (a, b) => b[1] - a[1],
        );
        console.log('  unrecognized (left unchanged):');
        for (const [value, count] of sortedUnrec.slice(0, 10)) {
          console.log(`    ${value.padEnd(46)} ${count.toLocaleString()}`);
        }
        if (sortedUnrec.length > 10) {
          console.log(`    … and ${sortedUnrec.length - 10} more value(s)`);
        }
      }

      totalScanned += r.scanned;
      totalChanged += r.changed;
      totalSkipped += r.skipped;
    }

    console.log('\n' + '─'.repeat(56));
    console.log(
      `TOTAL   scanned: ${totalScanned.toLocaleString()}   ` +
      `${dryRun ? 'would update' : 'updated'}: ${totalChanged.toLocaleString()}` +
      (totalSkipped ? `   unrecognized: ${totalSkipped.toLocaleString()}` : ''),
    );
    process.exit(0);
  } catch (error) {
    console.error('Script failed:', error);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
  }
}

run();
