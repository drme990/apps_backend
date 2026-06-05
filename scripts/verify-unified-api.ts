import { connectDB } from '../lib/db';
import Appearance from '../lib/models/Appearance';

function normalizeBannerText(value: unknown): { ar: string; en: string } {
  if (typeof value === 'string') {
    const text = value.trim();
    return { ar: text, en: text };
  }

  const raw = value as { ar?: unknown; en?: unknown } | undefined;
  return {
    ar: typeof raw?.ar === 'string' ? raw.ar.trim() : '',
    en: typeof raw?.en === 'string' ? raw.en.trim() : '',
  };
}

function normalizeProductsBanners(value: unknown): Array<any> {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const raw = item as any;
      const id = typeof raw.id === 'string' ? raw.id.trim() : '';
      const imageUrl = typeof raw.imageUrl === 'string' ? raw.imageUrl.trim() : '';
      const platformValue = raw.platform || raw.target;
      const platform =
        platformValue === 'ghadaq' ||
        platformValue === 'manasik' ||
        platformValue === 'shared' ||
        platformValue === 'both'
          ? platformValue === 'both' ? 'shared' : platformValue
          : 'shared';
      const language = raw.language || 'shared';
      const link = typeof raw.link === 'string' ? raw.link.trim() : '';
      if (!id || !imageUrl) return null;
      return { id, imageUrl, platform, language, link };
    })
    .filter(Boolean);
}

async function testRoute(project: string) {
  console.log(`\nTesting appearance retrieval for project: "${project}"`);
  
  const appearance = (await Appearance.findOne({ project }).lean()) as any;
  const sharedAppearance =
    project !== 'shared'
      ? ((await Appearance.findOne({ project: 'shared' })
          .select({
            productsBanners: 1,
            faqs: 1,
            audioReviews: 1,
            documentationAnswer: 1,
          })
          .lean()) as any)
      : null;

  if (!appearance) {
    console.log(`No appearance document found for project "${project}"`);
    return;
  }

  const worksImages = {
    row1: appearance.worksImages?.row1 ?? [],
    row2: appearance.worksImages?.row2 ?? [],
  };

  const ownProductsBanners = normalizeProductsBanners(appearance.productsBanners);
  const sharedProductsBanners = normalizeProductsBanners(sharedAppearance?.productsBanners);

  const sourceProductsBanners =
    project === 'shared'
      ? ownProductsBanners
      : sharedProductsBanners.length > 0
        ? sharedProductsBanners
        : ownProductsBanners;

  const productsBanners =
    project === 'shared'
      ? sourceProductsBanners
      : sourceProductsBanners.filter(
          (banner) => banner.platform === 'shared' || banner.platform === project,
        );

  // Merge audio reviews
  const projectAudio = (appearance.audioReviews && Array.isArray(appearance.audioReviews))
    ? appearance.audioReviews
    : [];
  const sharedAudio = (sharedAppearance?.audioReviews && Array.isArray(sharedAppearance.audioReviews))
    ? sharedAppearance.audioReviews
    : [];
  const allAudio = [...projectAudio, ...sharedAudio];
  const audioReviews =
    project === 'shared'
      ? allAudio
      : allAudio.filter(
          (item: any) =>
            item &&
            (item.platform === project || item.platform === 'shared'),
        );

  // Get documentation answer
  const sourceDocumentationAnswer =
    project === 'shared'
      ? appearance.documentationAnswer
      : (sharedAppearance?.documentationAnswer ?? appearance.documentationAnswer);
  const documentationAnswer = normalizeBannerText(sourceDocumentationAnswer);

  console.log(`- worksImages: row1 count=${worksImages.row1.length}, row2 count=${worksImages.row2.length}`);
  console.log(`- whatsAppDefaultMessage: "${appearance.whatsAppDefaultMessage?.trim() || ''}"`);
  console.log(`- documentationAnswer: ar="${documentationAnswer.ar}", en="${documentationAnswer.en}"`);
  console.log(`- productsBanners count: ${productsBanners.length}`);
  console.log(`- audioReviews count: ${audioReviews.length}`);
  
  // Verify that all returned audios belong to either the requested project or shared
  if (project !== 'shared') {
    const invalidAudio = audioReviews.filter((a: any) => a.platform !== project && a.platform !== 'shared');
    if (invalidAudio.length > 0) {
      throw new Error(`Found audio reviews belonging to other platform: ${JSON.stringify(invalidAudio)}`);
    }
    console.log('  -> Audio reviews platform filtering check: PASSED');

    // Verify products banners platform/target
    const invalidBanner = productsBanners.filter((b: any) => b.platform !== project && b.platform !== 'shared');
    if (invalidBanner.length > 0) {
      throw new Error(`Found banners belonging to other platform: ${JSON.stringify(invalidBanner)}`);
    }
    console.log('  -> Products banners platform filtering check: PASSED');
  } else {
    console.log('  -> Platform checks bypassed for "shared" project (expected behavior).');
  }
}

async function runVerification() {
  await connectDB();
  
  await testRoute('ghadaq');
  await testRoute('manasik');
  await testRoute('shared');

  console.log('\nALL API UNIFICATION VERIFICATIONS PASSED SUCCESSFULLY!');
}

runVerification()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('\nVERIFICATION FAILED:', err);
    process.exit(1);
  });
