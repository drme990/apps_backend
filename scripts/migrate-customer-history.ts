/**
 * Migration script: Merge CustomerRefHistory and CustomerCountryHistory
 * into a single CustomerHistory collection.
 *
 * Run with: npx ts-node scripts/migrate-customer-history.ts
 */

import mongoose from 'mongoose';
import { connectDB } from '@/lib/db';

async function migrate() {
  await connectDB();

  const db = mongoose.connection.db;
  if (!db) {
    throw new Error('Database connection not established');
  }

  const customerHistory = db.collection('customerhistories');

  // Ensure CustomerHistory collection exists with indexes
  await customerHistory.createIndex({ customerId: 1, type: 1, createdAt: -1 });
  await customerHistory.createIndex({ appId: 1, type: 1, createdAt: -1 });
  await customerHistory.createIndex({ type: 1, createdAt: -1 });

  // Migrate ref history
  const refCollection = db.collection('customerrefhistories');
  const refCursor = refCollection.find({});
  let refMigrated = 0;

  for await (const doc of refCursor) {
    await customerHistory.insertOne({
      customerId: doc.customerId,
      appId: doc.appId,
      customerName: doc.customerName || null,
      customerEmail: doc.customerEmail || null,
      type: 'ref',
      previousValue: doc.previousRef ?? null,
      newValue: doc.newRef ?? null,
      changeSource: doc.changeSource || 'single',
      changedByUserId: doc.changedByUserId,
      changedByUserName: doc.changedByUserName,
      changedByUserEmail: doc.changedByUserEmail,
      createdAt: doc.createdAt || new Date(),
    });
    refMigrated++;
  }

  // Migrate country history
  const countryCollection = db.collection('customercountryhistories');
  const countryCursor = countryCollection.find({});
  let countryMigrated = 0;

  for await (const doc of countryCursor) {
    await customerHistory.insertOne({
      customerId: doc.customerId,
      appId: doc.appId,
      customerName: doc.customerName || null,
      customerEmail: doc.customerEmail || null,
      type: 'country',
      previousValue: doc.previousCountry ?? null,
      newValue: doc.newCountry ?? null,
      changeSource: null,
      changedByUserId: doc.changedByUserId,
      changedByUserName: doc.changedByUserName,
      changedByUserEmail: doc.changedByUserEmail,
      createdAt: doc.createdAt || new Date(),
    });
    countryMigrated++;
  }

  console.log(`Migration complete:`);
  console.log(`  Ref history entries migrated: ${refMigrated}`);
  console.log(`  Country history entries migrated: ${countryMigrated}`);
  console.log(`  Total entries in CustomerHistory: ${refMigrated + countryMigrated}`);

  await mongoose.disconnect();
  process.exit(0);
}

migrate().catch((error) => {
  console.error('Migration failed:', error);
  process.exit(1);
});
