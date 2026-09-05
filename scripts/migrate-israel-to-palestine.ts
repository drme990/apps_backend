/**
 * Migration script: Replace all references to Israel (code 'IL' or name 'Israel')
 * with Palestine (code 'PS' or name 'Palestine') on customer collections,
 * and remove the Israel country document from the countries collection.
 *
 * Affected collections / fields:
 *   - users_manasik:  country, detectedCountry
 *   - users_ghadaq:   country, detectedCountry
 *   - countries:      delete document with code 'IL'
 *
 * Usage:
 *   MONGO_URI="mongodb://localhost:27017/manasik" npx tsx scripts/migrate-israel-to-palestine.ts
 *
 * Dry-run (no writes, just reports):
 *   MONGO_URI="..." DRY_RUN=1 npx tsx scripts/migrate-israel-to-palestine.ts
 */

import { MongoClient } from 'mongodb';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/manasik';
const DRY_RUN = process.env.DRY_RUN === '1';

const ISRAEL_CODE = 'IL';
const PALESTINE_CODE = 'PS';
const PALESTINE_NAME = 'Palestine';

interface MigrationStats {
  collection: string;
  field: string;
  matched: number;
  modified: number;
}

const stats: MigrationStats[] = [];

function log(msg: string) {
  console.log(msg);
}

async function migrateCollection(
  db: ReturnType<MongoClient['db']>,
  collectionName: string,
  builds: Array<{
    name: string;
    find: Record<string, unknown>;
    update: Record<string, unknown>;
  }>,
) {
  const collection = db.collection(collectionName);
  for (const build of builds) {
    const count = await collection.countDocuments(build.find);
    log(`  [${collectionName}] ${build.name}: ${count} matched`);

    if (DRY_RUN) {
      stats.push({ collection: collectionName, field: build.name, matched: count, modified: 0 });
      continue;
    }

    if (count === 0) {
      stats.push({ collection: collectionName, field: build.name, matched: 0, modified: 0 });
      continue;
    }

    const result = await collection.updateMany(build.find, build.update);
    log(`    → ${result.modifiedCount} modified`);
    stats.push({
      collection: collectionName,
      field: build.name,
      matched: count,
      modified: result.modifiedCount,
    });
  }
}

async function migrate() {
  const client = new MongoClient(MONGO_URI);

  try {
    await client.connect();
    log('✅ Connected to MongoDB');
    log(DRY_RUN ? '🔍 DRY RUN — no writes will occur\n' : '🔧 Migration mode — writes enabled\n');

    const db = client.db();

    // ── 1. users_manasik ──
    await migrateCollection(db, 'users_manasik', [
      {
        name: 'country (Israel → Palestine)',
        find: { country: { $in: [/^israel$/i, /^إسرائيل$/] } },
        update: { $set: { country: PALESTINE_NAME } },
      },
      {
        name: 'detectedCountry (IL → PS)',
        find: { detectedCountry: { $in: [ISRAEL_CODE, /^israel$/i, /^إسرائيل$/] } },
        update: { $set: { detectedCountry: PALESTINE_CODE } },
      },
    ]);

    // ── 2. users_ghadaq ──
    await migrateCollection(db, 'users_ghadaq', [
      {
        name: 'country (Israel → Palestine)',
        find: { country: { $in: [/^israel$/i, /^إسرائيل$/] } },
        update: { $set: { country: PALESTINE_NAME } },
      },
      {
        name: 'detectedCountry (IL → PS)',
        find: { detectedCountry: { $in: [ISRAEL_CODE, /^israel$/i, /^إسرائيل$/] } },
        update: { $set: { detectedCountry: PALESTINE_CODE } },
      },
    ]);

    // ── 3. countries — remove the Israel document ──
    const countriesCol = db.collection('countries');
    const ilCount = await countriesCol.countDocuments({ code: ISRAEL_CODE });
    log(`  [countries] delete IL document: ${ilCount} matched`);

    if (DRY_RUN) {
      stats.push({ collection: 'countries', field: 'delete IL document', matched: ilCount, modified: 0 });
    } else if (ilCount > 0) {
      const result = await countriesCol.deleteMany({ code: ISRAEL_CODE });
      log(`    → ${result.deletedCount} deleted`);
      stats.push({ collection: 'countries', field: 'delete IL document', matched: ilCount, modified: result.deletedCount });
    } else {
      stats.push({ collection: 'countries', field: 'delete IL document', matched: 0, modified: 0 });
    }

    // ── Summary ──
    log('\n' + '═'.repeat(60));
    log('📊 MIGRATION SUMMARY');
    log('═'.repeat(60));
    let totalMatched = 0;
    let totalModified = 0;
    for (const s of stats) {
      log(`  ${s.collection.padEnd(20)} ${s.field.padEnd(40)} matched: ${String(s.matched).padStart(6)}  modified: ${String(s.modified).padStart(6)}`);
      totalMatched += s.matched;
      totalModified += s.modified;
    }
    log('─'.repeat(60));
    log(`  ${'TOTAL'.padEnd(20)} ${''.padEnd(40)} matched: ${String(totalMatched).padStart(6)}  modified: ${String(totalModified).padStart(6)}`);
    log('═'.repeat(60));

    if (DRY_RUN) {
      log('\n🔍 Dry run complete. Run without DRY_RUN=1 to apply changes.');
    } else {
      log('\n✅ Migration complete.');
    }
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  } finally {
    await client.close();
  }
}

void migrate();
