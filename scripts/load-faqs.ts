import mongoose from 'mongoose';
import { connectDB } from '../lib/db';
import Appearance from '../lib/models/Appearance';
import fs from 'fs';
import path from 'path';

interface FAQData {
  question: string;
  answer: string;
}

interface PlatformFAQs {
  en: Record<string, FAQData>;
  ar: Record<string, FAQData>;
}

interface AllFAQs {
  manasik: PlatformFAQs;
  ghadaq: PlatformFAQs;
}

async function loadFAQs() {
  try {
    await connectDB();
    console.log('Connected to database');

    const faqPath = path.join(__dirname, 'faq.json');
    const faqData: AllFAQs = JSON.parse(fs.readFileSync(faqPath, 'utf-8'));
    console.log('Loaded FAQ data from file');

    const allFAQs: any[] = [];

    for (const [platform, platformFAQs] of Object.entries(faqData)) {
      if (platform !== 'manasik' && platform !== 'ghadaq') {
        console.log(`Skipping unknown platform: ${platform}`);
        continue;
      }

      console.log(`Processing FAQs for platform: ${platform}`);

      const questionKeys = Object.keys(platformFAQs.en);
      
      for (const key of questionKeys) {
        const enData = platformFAQs.en[key];
        const arData = platformFAQs.ar[key];
        
        if (enData && arData) {
          allFAQs.push({
            id: `${platform}-${key}`,
            question: {
              ar: arData.question,
              en: enData.question,
            },
            answer: {
              ar: arData.answer,
              en: enData.answer,
            },
            platform: platform as 'ghadaq' | 'manasik',
            showOnProductDetails: false,
          });
        }
      }

      console.log(`Converted ${questionKeys.length} FAQs for ${platform}`);
    }

    console.log(`Total FAQs to load: ${allFAQs.length}`);

    await Appearance.updateOne(
      { project: 'shared' },
      { $set: { faqs: allFAQs } },
      { upsert: true }
    );

    console.log('FAQ loading complete.');
    process.exit(0);
  } catch (error) {
    console.error('FAQ loading failed:', error);
    process.exit(1);
  }
}

loadFAQs();
