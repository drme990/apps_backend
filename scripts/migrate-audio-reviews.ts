/// <reference types="node" />
import mongoose from 'mongoose';
import { connectDB } from '../lib/db';
import Appearance from '../lib/models/Appearance';

// Generate a simple ID
function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
}

interface OldAudioReviews {
  ar?: string[];
  en?: string[];
}

interface NewAudioReview {
  id: string;
  url: string;
  nameAr: string;
  nameEn: string;
  userImage: string;
  platform: 'ghadaq' | 'manasik' | 'shared';
  language: 'ar' | 'en' | 'shared';
  isMain: boolean;
}

async function migrateAudioReviews() {
  console.log('Starting audio reviews migration...\n');

  try {
    await connectDB();
    console.log('✓ Connected to MongoDB\n');

    // Fetch all appearance documents
    const appearances = await Appearance.find({});
    console.log(`Found ${appearances.length} appearance documents\n`);

    let totalMigrated = 0;
    let totalErrors = 0;
    const allNewAudioReviews: NewAudioReview[] = [];

    // First pass: collect all audio from all projects
    for (const appearance of appearances) {
      const project = appearance.project;
      console.log(`Collecting audio from project: ${project}`);

      const oldAudioReviews = appearance.audioReviews as OldAudioReviews | unknown[] | undefined;

      if (!oldAudioReviews) {
        console.log(`  - No audio reviews found, skipping\n`);
        continue;
      }

      // Skip if already in new format (array of objects with id and url)
      if (Array.isArray(oldAudioReviews) && oldAudioReviews.length > 0 && typeof oldAudioReviews[0] === 'object' && oldAudioReviews[0] !== null && 'id' in oldAudioReviews[0]) {
        console.log(`  - Already in new format, collecting ${oldAudioReviews.length} audio reviews\n`);
        const existingAudios = oldAudioReviews as NewAudioReview[];
        allNewAudioReviews.push(...existingAudios);
        continue;
      }

      const oldFormat = oldAudioReviews as OldAudioReviews;
      let projectMigrated = 0;

      // Process AR audio
      if (oldFormat.ar && Array.isArray(oldFormat.ar)) {
        for (let i = 0; i < oldFormat.ar.length; i++) {
          const url = oldFormat.ar[i];
          if (typeof url === 'string' && url.trim()) {
            allNewAudioReviews.push({
              id: generateId(),
              url: url.trim(),
              nameAr: 'مستخدم',
              nameEn: 'User',
              userImage: '',
              platform: project === 'shared' ? 'shared' : project,
              language: 'ar',
              isMain: i === 0, // First audio is main
            });
            projectMigrated++;
          }
        }
      }

      // Process EN audio
      if (oldFormat.en && Array.isArray(oldFormat.en)) {
        for (let i = 0; i < oldFormat.en.length; i++) {
          const url = oldFormat.en[i];
          if (typeof url === 'string' && url.trim()) {
            allNewAudioReviews.push({
              id: generateId(),
              url: url.trim(),
              nameAr: 'مستخدم',
              nameEn: 'User',
              userImage: '',
              platform: project === 'shared' ? 'shared' : project,
              language: 'en',
              isMain: i === 0, // First audio is main
            });
            projectMigrated++;
          }
        }
      }

      console.log(`  - Collected ${projectMigrated} audio reviews from ${project}\n`);
      totalMigrated += projectMigrated;
    }

    if (allNewAudioReviews.length === 0) {
      console.log('No audio reviews to migrate.\n');
      process.exit(0);
    }

    console.log(`\nTotal audio reviews to consolidate: ${allNewAudioReviews.length}\n`);

    try {
      // Clear audio from ghadaq and manasik documents
      await Appearance.updateMany(
        { project: { $in: ['ghadaq', 'manasik'] } },
        { $set: { audioReviews: [] } },
      );
      console.log('✓ Cleared audio from ghadaq and manasik documents');

      // Update shared document with all audio reviews
      await Appearance.updateOne(
        { project: 'shared' },
        {
          $set: {
            audioReviews: allNewAudioReviews,
          },
        },
        { upsert: true },
      );
      console.log(`✓ Consolidated ${allNewAudioReviews.length} audio reviews into shared document`);

      console.log('\n' + '='.repeat(50));
      console.log('Migration Summary');
      console.log('='.repeat(50));
      console.log(`Total audio reviews migrated: ${totalMigrated}`);
      console.log(`Total errors: ${totalErrors}`);
      console.log('All audio reviews are now stored in the "shared" project.');
      console.log('='.repeat(50));
      console.log('\n✓ Migration completed successfully!');
    } catch (error) {
      console.error('\n✗ Error during consolidation:', error);
      totalErrors++;
    }

    process.exit(totalErrors === 0 ? 0 : 1);
  } catch (error) {
    console.error('\n✗ Migration failed:', error);
    process.exit(1);
  }
}

// Run the migration
migrateAudioReviews();
