/**
 * Script: Download a full dump of every collection in the database.
 *
 * Each collection is written to its own JSON file:
 *   db-export/<collection>.json
 *
 * Files use MongoDB Extended JSON (EJSON), so ObjectId / Date / etc.
 * keep their real types and can be re-imported with mongoimport.
 *
 * READ-ONLY — performs find() scans only, never writes to the DB.
 *
 * Usage:
 *   1) Paste your connection string into DB_URI below
 *   2) npx tsx scripts/download-database.ts
 *
 * Options:
 *   --uri="mongodb+srv://..."   override DB_URI / DATA_BASE_URL
 *   --out=folder-name           override output dir (default: db-export)
 *   --only=orders,products      export only these collections
 */

// ── Paste your MongoDB connection link here ──
const DB_URI = 'mongodb://localhost:27017/manasik';

import { MongoClient } from 'mongodb';
import type { MongoClientOptions } from 'mongodb';
import { EJSON } from 'bson';

declare function require(name: string): unknown;
const fs = require('fs') as {
  existsSync(filePath: string): boolean;
  readFileSync(filePath: string, encoding: string): string;
  mkdirSync(filePath: string, opts?: { recursive?: boolean }): void;
  createWriteStream(filePath: string): {
    write(chunk: string): void;
    end(): void;
    once(event: 'finish', cb: () => void): void;
  };
};
const path = require('path') as {
  join(...parts: string[]): string;
  resolve(...parts: string[]): string;
};

declare const process: {
  env: Record<string, string | undefined>;
  cwd: () => string;
  argv: string[];
  stdout: { write(text: string): void };
  exit: (code?: number) => never;
};

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

function safeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_.-]/g, '_');
}

async function main() {
  loadEnvFiles();
  const uri = getMongoUri();
  const outDir = path.resolve(process.cwd(), argValue('--out') ?? 'db-export');
  const only = argValue('--only')
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 15_000,
  } as MongoClientOptions);
  await client.connect();
  const db = client.db();
  console.log(`Connected: ${db.databaseName} (${client.options.hosts?.[0]?.host ?? 'mongo'})`);

  const all = await db
    .listCollections({ type: 'collection' }, { nameOnly: true })
    .toArray();
  const names = all
    .map((c) => c.name)
    .filter((n) => !n.startsWith('system.'))
    .filter((n) => !only || only.includes(n))
    .sort();

  if (only) {
    const missing = only.filter((n) => !names.includes(n));
    if (missing.length)
      console.log(`Not found (skipped): ${missing.join(', ')}`);
  }
  if (!names.length) {
    console.log('No collections to export.');
    await client.close();
    return;
  }

  fs.mkdirSync(outDir, { recursive: true });
  console.log(`Exporting ${names.length} collection(s) → ${outDir}\n`);

  let totalDocs = 0;
  for (const name of names) {
    const file = path.join(outDir, `${safeFileName(name)}.json`);
    const stream = fs.createWriteStream(file);
    stream.write('[\n');

    let count = 0;
    let first = true;
    const cursor = db.collection(name).find({});
    for await (const doc of cursor) {
      if (!first) stream.write(',\n');
      first = false;
      stream.write(EJSON.stringify(doc));
      count++;
      if (count % 5000 === 0)
        process.stdout.write(`  ${name}: ${count.toLocaleString()}...\r`);
    }
    stream.write('\n]\n');
    stream.end();

    totalDocs += count;
    console.log(`  ${name.padEnd(40)} ${count.toLocaleString()} docs`);
  }

  console.log(
    `\nDone — ${names.length} collection(s), ${totalDocs.toLocaleString()} documents → ${outDir}`,
  );
  await client.close();
}

main().catch((err) => {
  console.error('Export failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
