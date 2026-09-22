/**
 * Script: Restore collections from EJSON export files (one
 * <collection>.json file per collection) into a database.
 *
 * Merge behavior (per document, matched by _id):
 *   - _id exists in DB      → document REPLACED by the file version
 *   - _id not in DB         → document INSERTED
 *   - DB has docs not in file → left untouched (never deleted)
 *
 * Files are MongoDB Extended JSON (EJSON) — ObjectId / Date / etc.
 * restore to their real types automatically.
 *
 * Usage:
 *   1) Paste your connection string into DB_URI below
 *   2) npx tsx scripts/restore-database.ts --dry-run   # preview counts
 *      npx tsx scripts/restore-database.ts            # apply
 *
 * Options:
 *   --uri="mongodb+srv://..."   override DB_URI / DATA_BASE_URL
 *   --in=folder-name            input dir (default: db-export)
 *   --only=orders,products      restore only these collections
 *   --dry-run                   count only, write nothing
 */

// ── Paste your MongoDB connection link here ──
const DB_URI = '';

import { MongoClient } from 'mongodb';
import type { MongoClientOptions } from 'mongodb';
import { EJSON } from 'bson';
import type { Document } from 'mongodb';

declare function require(name: string): unknown;
const fs = require('fs') as {
  existsSync(filePath: string): boolean;
  readFileSync(filePath: string, encoding: string): string;
  readdirSync(dirPath: string): string[];
};
const path = require('path') as {
  join(...parts: string[]): string;
  resolve(...parts: string[]): string;
  extname(filePath: string): string;
  basename(filePath: string, ext?: string): string;
};

declare const process: {
  env: Record<string, string | undefined>;
  cwd: () => string;
  argv: string[];
  stdout: { write(text: string): void };
  exit: (code?: number) => never;
};

const dryRun = process.argv.includes('--dry-run');
const BULK_CHUNK = 500;

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

function argValue(flag: string): string | null {
  const hit = process.argv.find((a) => a.startsWith(flag + '='));
  return hit ? hit.slice(flag.length + 1) : null;
}

function getMongoUri(): string {
  const cli = argValue('--uri');
  if (cli) return cli;
  if (DB_URI) return DB_URI;
  if (process.env.DATA_BASE_URL) return process.env.DATA_BASE_URL;
  console.error(
    'No MongoDB URI — paste it into DB_URI at the top of this file, ' +
    'pass --uri=..., or set DATA_BASE_URL in .env',
  );
  process.exit(1);
}

async function main() {
  loadEnvFiles();
  const uri = getMongoUri();
  const inDir = path.resolve(process.cwd(), argValue('--in') ?? 'db-export');
  const only = argValue('--only')
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (!fs.existsSync(inDir)) {
    console.error(`Input folder not found: ${inDir}`);
    process.exit(1);
  }

  const files = fs
    .readdirSync(inDir)
    .filter((f) => path.extname(f) === '.json')
    .filter((f) => !only || only.includes(path.basename(f, '.json')))
    .sort();

  if (!files.length) {
    console.log(`No .json collection files in ${inDir}`);
    return;
  }

  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 15_000,
  } as MongoClientOptions);
  await client.connect();
  const db = client.db();
  console.log(
    `Connected: ${db.databaseName} (${client.options.hosts?.[0]?.host ?? 'mongo'})`,
  );
  console.log(
    `${dryRun ? 'DRY RUN — nothing will be written\n' : ''}` +
    `Restoring ${files.length} collection file(s) from ${inDir}\n`,
  );

  let totalReplaced = 0;
  let totalInserted = 0;
  let totalKept = 0;

  for (const file of files) {
    const collectionName = path.basename(file, '.json');
    const filePath = path.join(inDir, file);

    let docs: Document[];
    try {
      docs = EJSON.parse(fs.readFileSync(filePath, 'utf8')) as Document[];
    } catch (err) {
      console.log(
        `  ${collectionName.padEnd(40)} SKIPPED — bad JSON: ` +
        `${err instanceof Error ? err.message : err}`,
      );
      continue;
    }
    if (!Array.isArray(docs)) {
      console.log(`  ${collectionName.padEnd(40)} SKIPPED — not an array`);
      continue;
    }

    const collection = db.collection(collectionName);
    const beforeCount = await collection.countDocuments();

    let replaced = 0;
    let inserted = 0;

    if (!dryRun) {
      for (let i = 0; i < docs.length; i += BULK_CHUNK) {
        const chunk = docs.slice(i, i + BULK_CHUNK);
        const result = await collection.bulkWrite(
          chunk.map((doc) => ({
            replaceOne: {
              filter: { _id: doc._id },
              replacement: doc,
              upsert: true,
            },
          })),
          { ordered: false },
        );
        replaced += result.matchedCount;
        inserted += result.upsertedCount;
        process.stdout.write(
          `  ${collectionName}: ${Math.min(i + BULK_CHUNK, docs.length).toLocaleString()}/${docs.length.toLocaleString()}\r`,
        );
      }
    } else {
      const fileIds = new Set(docs.map((d) => String(d._id)));
      const existing = await collection
        .find({}, { projection: { _id: 1 } })
        .toArray();
      for (const e of existing) {
        if (fileIds.has(String(e._id))) replaced++;
      }
      inserted = docs.length - replaced;
    }

    const kept = beforeCount - replaced;
    totalReplaced += replaced;
    totalInserted += inserted;
    totalKept += kept;

    console.log(
      `  ${collectionName.padEnd(40)} ` +
      `${dryRun ? 'would replace' : 'replaced'}: ${replaced.toLocaleString()}  ` +
      `${dryRun ? 'would insert' : 'inserted'}: ${inserted.toLocaleString()}  ` +
      `kept (in DB only): ${kept.toLocaleString()}`,
    );
  }

  console.log(
    `\n${dryRun ? 'Dry run' : 'Done'} — ` +
    `${dryRun ? 'would replace' : 'replaced'}: ${totalReplaced.toLocaleString()}  ` +
    `${dryRun ? 'would insert' : 'inserted'}: ${totalInserted.toLocaleString()}  ` +
    `kept (in DB only): ${totalKept.toLocaleString()}`,
  );
  await client.close();
}

main().catch((err) => {
  console.error('Restore failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
