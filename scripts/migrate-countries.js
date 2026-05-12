// migrate-countries.js

import { MongoClient } from 'mongodb';

/**
 * Example:
 * mongodb://localhost:27017/manasik
 *
 * OR
 *
 * mongodb+srv://user:pass@cluster.mongodb.net/manasik
 */
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/manasik';

const COLLECTION_NAME = 'countries';

async function migrate() {
  const client = new MongoClient(MONGO_URI);

  try {
    await client.connect();

    console.log('✅ Connected to MongoDB');

    // Uses DB directly from connection string
    const db = client.db();

    const collection = db.collection(COLLECTION_NAME);

    // Find old documents
    const docs = await collection
      .find({
        visibleToCountries: { $exists: true },
      })
      .toArray();

    console.log(`📦 Found ${docs.length} documents to migrate`);

    for (const doc of docs) {
      const countriesToSee = {};

      // Make all countries realPrice = true
      for (const countryCode of doc.visibleToCountries || []) {
        countriesToSee[countryCode] = {
          realPrice: true,
          exchangePrice: false,
        };
      }

      const updatePayload = {
        $set: {
          countriesToSee,
          visibilityMode: 'custom',
          updatedAt: new Date(),
        },

        $unset: {
          visibleToCountries: '',
          visibleToOther: '',
        },
      };

      await collection.updateOne({ _id: doc._id }, updatePayload);

      console.log(`✅ Migrated ${doc.code}`);
    }

    console.log('🎉 Migration completed successfully');
  } catch (error) {
    console.error('❌ Migration failed');
    console.error(error);
  } finally {
    await client.close();
    console.log('🔌 MongoDB connection closed');
  }
}

migrate();
