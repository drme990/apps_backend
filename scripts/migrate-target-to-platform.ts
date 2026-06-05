import mongoose from 'mongoose';
import { connectDB } from '../lib/db';
import Appearance from '../lib/models/Appearance';

async function migrateTargetToPlatform() {
  try {
    await connectDB();
    console.log('Connected to database');

    const appearances = await Appearance.find({});
    console.log(`Found ${appearances.length} appearance documents`);

    let updatedCount = 0;

    for (const appearance of appearances) {
      let needsUpdate = false;
      const updatedAppearance = appearance.toObject() as any;

      // Migrate productsBanners
      if (updatedAppearance.productsBanners && Array.isArray(updatedAppearance.productsBanners)) {
        for (const banner of updatedAppearance.productsBanners) {
          if ((banner as any).target && !(banner as any).platform) {
            // Convert 'both' to 'shared'
            (banner as any).platform = (banner as any).target === 'both' ? 'shared' : (banner as any).target;
            delete (banner as any).target;
            needsUpdate = true;
          }
        }
      }

      if (needsUpdate) {
        await Appearance.updateOne(
          { _id: appearance._id },
          { $set: { productsBanners: updatedAppearance.productsBanners } }
        );
        updatedCount++;
        console.log(`Updated appearance for project: ${appearance.project}`);
      }
    }

    console.log(`Migration complete. Updated ${updatedCount} documents.`);
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

migrateTargetToPlatform();
