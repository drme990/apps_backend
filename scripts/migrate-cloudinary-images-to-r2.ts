import mongoose from 'mongoose';

declare function require(name: string): unknown;
declare const process: {
  env: Record<string, string | undefined>;
  cwd: () => string;
  argv: string[];
  exit: (code?: number) => never;
};

const fs = require('fs') as {
  existsSync: (filePath: string) => boolean;
  readFileSync: (filePath: string, encoding: string) => string;
};

const path = require('path') as {
  join: (...paths: string[]) => string;
  extname: (filePath: string) => string;
};

type CollectionName = 'products' | 'orders' | 'appearances';
type TargetFolder = 'products/images' | 'images/customers' | 'images/website';

interface MigrationCandidate {
  collection: CollectionName;
  docId: string;
  docLabel: string;
  fieldPath: string;
  sourceUrl: string;
  targetFolder: TargetFolder;
}

interface DownloadedAsset {
  buffer: Uint8Array;
  contentType: string;
  fileName: string;
}

const CLOUDINARY_IMAGE_URL_RE =
  /^https?:\/\/res\.cloudinary\.com\/[^/]+\/image\/upload\//i;
const DEFAULT_MONGODB_URI = 'mongodb://localhost:27017/manasik';
const UPLOAD_TIMEOUT_MS = 60_000;

const CONTENT_TYPE_BY_EXTENSION: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.svg': 'image/svg+xml',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
};

function loadEnvFile(filePath: string) {
  if (!fs.existsSync(filePath)) return;

  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const separatorIndex = line.indexOf('=');
    if (separatorIndex <= 0) continue;

    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

function loadEnvFiles() {
  const cwd = process.cwd();
  const parent = path.join(cwd, '..');

  for (const basePath of [cwd, parent]) {
    loadEnvFile(path.join(basePath, '.env'));
    loadEnvFile(path.join(basePath, '.env.local'));
  }
}

function getMongoUri(): string {
  const cliUriArg = process.argv.find((arg) => arg.startsWith('--uri='));
  if (cliUriArg) return cliUriArg.slice('--uri='.length);

  return process.env.DATA_BASE_URL || DEFAULT_MONGODB_URI;
}

function isApplyMode(): boolean {
  return process.argv.includes('--apply');
}

function normalizeString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isCloudinaryImageUrl(value: unknown): value is string {
  return typeof value === 'string' && CLOUDINARY_IMAGE_URL_RE.test(value);
}

function getFileNameFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const baseName = parsed.pathname.split('/').pop() || 'image.jpg';
    return decodeURIComponent(baseName);
  } catch {
    return 'image.jpg';
  }
}

function getContentTypeFromUrl(url: string, fallback = 'image/jpeg'): string {
  try {
    const parsed = new URL(url);
    const extension = path.extname(parsed.pathname).toLowerCase();
    return CONTENT_TYPE_BY_EXTENSION[extension] || fallback;
  } catch {
    return fallback;
  }
}

async function downloadCloudinaryImage(url: string): Promise<DownloadedAsset> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Download failed with status ${response.status}`);
    }

    const buffer = new Uint8Array(await response.arrayBuffer());
    const contentType =
      response.headers.get('content-type') || getContentTypeFromUrl(url);

    return {
      buffer,
      contentType,
      fileName: getFileNameFromUrl(url),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function migrateAsset(
  sourceUrl: string,
  targetFolder: TargetFolder,
  uploadFileToR2: (
    file: File,
    folder?: string,
  ) => Promise<{ url: string; key: string }>,
): Promise<string> {
  const downloaded = await downloadCloudinaryImage(sourceUrl);
  const fileBuffer = downloaded.buffer.buffer.slice(
    downloaded.buffer.byteOffset,
    downloaded.buffer.byteOffset + downloaded.buffer.byteLength,
  ) as ArrayBuffer;
  const file = new File([fileBuffer], downloaded.fileName, {
    type: downloaded.contentType,
  });

  const result = await uploadFileToR2(file, targetFolder);
  return result.url;
}

function docLabel(
  collection: CollectionName,
  doc: {
    _id?: unknown;
    slug?: unknown;
    orderNumber?: unknown;
    project?: unknown;
  },
) {
  const id = String(doc._id ?? 'unknown');
  const extras = [doc.slug, doc.orderNumber, doc.project]
    .map((value) => normalizeString(value))
    .filter((value): value is string => Boolean(value));

  return extras.length > 0
    ? `${collection}:${id} (${extras.join(' | ')})`
    : `${collection}:${id}`;
}

async function collectProductCandidates(): Promise<MigrationCandidate[]> {
  const collection = mongoose.connection.collection('products');
  const documents = await collection
    .find(
      { 'media.url': { $regex: CLOUDINARY_IMAGE_URL_RE } },
      { projection: { media: 1, slug: 1 } },
    )
    .toArray();

  const candidates: MigrationCandidate[] = [];

  for (const product of documents) {
    if (!Array.isArray(product.media)) continue;

    product.media.forEach(
      (mediaEntry: Record<string, unknown>, index: number) => {
        const url = normalizeString(mediaEntry.url);
        if (!url || !isCloudinaryImageUrl(url)) return;

        candidates.push({
          collection: 'products',
          docId: String(product._id),
          docLabel: docLabel('products', product),
          fieldPath: `media.${index}.url`,
          sourceUrl: url,
          targetFolder: 'products/images',
        });
      },
    );
  }

  return candidates;
}

async function collectOrderCandidates(): Promise<MigrationCandidate[]> {
  const collection = mongoose.connection.collection('orders');
  const documents = await collection
    .find(
      { 'reservationData.value': { $regex: CLOUDINARY_IMAGE_URL_RE } },
      { projection: { reservationData: 1, orderNumber: 1 } },
    )
    .toArray();

  const candidates: MigrationCandidate[] = [];

  for (const order of documents) {
    if (!Array.isArray(order.reservationData)) continue;

    order.reservationData.forEach(
      (answer: Record<string, unknown>, index: number) => {
        const key = normalizeString(answer.key);
        const type = normalizeString(answer.type);
        const url = normalizeString(answer.value);

        if (!url || !isCloudinaryImageUrl(url)) return;
        if (key !== 'photo' && type !== 'picture') return;

        candidates.push({
          collection: 'orders',
          docId: String(order._id),
          docLabel: docLabel('orders', order),
          fieldPath: `reservationData.${index}.value`,
          sourceUrl: url,
          targetFolder: 'images/customers',
        });
      },
    );
  }

  return candidates;
}

async function collectAppearanceCandidates(): Promise<MigrationCandidate[]> {
  const collection = mongoose.connection.collection('appearances');
  const documents = await collection
    .find(
      {},
      {
        projection: {
          project: 1,
          worksImages: 1,
          productsBanners: 1,
          audioReviews: 1,
        },
      },
    )
    .toArray();

  const candidates: MigrationCandidate[] = [];

  for (const appearance of documents) {
    const worksImages = appearance.worksImages;
    if (worksImages && typeof worksImages === 'object') {
      for (const rowName of ['row1', 'row2'] as const) {
        const row = Array.isArray(worksImages[rowName])
          ? worksImages[rowName]
          : [];
        row.forEach((url: unknown, index: number) => {
          const normalizedUrl = normalizeString(url);
          if (!normalizedUrl || !isCloudinaryImageUrl(normalizedUrl)) {
            return;
          }

          candidates.push({
            collection: 'appearances',
            docId: String(appearance._id),
            docLabel: docLabel('appearances', appearance),
            fieldPath: `worksImages.${rowName}.${index}`,
            sourceUrl: normalizedUrl,
            targetFolder: 'images/website',
          });
        });
      }
    }

    if (Array.isArray(appearance.productsBanners)) {
      appearance.productsBanners.forEach(
        (banner: Record<string, unknown>, index: number) => {
          const url = normalizeString(banner.imageUrl);
          if (!url || !isCloudinaryImageUrl(url)) return;

          candidates.push({
            collection: 'appearances',
            docId: String(appearance._id),
            docLabel: docLabel('appearances', appearance),
            fieldPath: `productsBanners.${index}.imageUrl`,
            sourceUrl: url,
            targetFolder: 'images/website',
          });
        },
      );
    }

    if (Array.isArray(appearance.audioReviews)) {
      appearance.audioReviews.forEach(
        (review: Record<string, unknown>, index: number) => {
          const url = normalizeString(review.userImage);
          if (!url || !isCloudinaryImageUrl(url)) return;

          candidates.push({
            collection: 'appearances',
            docId: String(appearance._id),
            docLabel: docLabel('appearances', appearance),
            fieldPath: `audioReviews.${index}.userImage`,
            sourceUrl: url,
            targetFolder: 'images/website',
          });
        },
      );
    }
  }

  return candidates;
}

async function main() {
  loadEnvFiles();
  const { uploadFileToR2 } = await import('../lib/services/r2');

  const uri = getMongoUri();
  const applyMode = isApplyMode();

  console.log(`[cloudinary-to-r2] Connecting to ${uri}`);
  await mongoose.connect(uri);

  const productCandidates = await collectProductCandidates();
  const orderCandidates = await collectOrderCandidates();
  const appearanceCandidates = await collectAppearanceCandidates();
  const candidates = [
    ...productCandidates,
    ...orderCandidates,
    ...appearanceCandidates,
  ];

  console.log('[cloudinary-to-r2] Scan summary:');
  console.log(`  products: ${productCandidates.length}`);
  console.log(`  orders: ${orderCandidates.length}`);
  console.log(`  appearances: ${appearanceCandidates.length}`);
  console.log(`  total: ${candidates.length}`);

  if (candidates.length === 0) {
    console.log('[cloudinary-to-r2] No Cloudinary image URLs were found.');
    await mongoose.disconnect();
    return;
  }

  if (!applyMode) {
    console.log(
      '\n[cloudinary-to-r2] Dry run only. Re-run with --apply to migrate the images.',
    );
    const sample = candidates.slice(0, 20);

    for (const item of sample) {
      console.log(`  - ${item.docLabel} :: ${item.fieldPath}`);
      console.log(`    ${item.sourceUrl}`);
    }

    if (candidates.length > sample.length) {
      console.log(`  ...and ${candidates.length - sample.length} more`);
    }

    await mongoose.disconnect();
    return;
  }

  const uploadCache = new Map<string, string>();
  const collections: Record<CollectionName, mongoose.Collection> = {
    products: mongoose.connection.collection('products'),
    orders: mongoose.connection.collection('orders'),
    appearances: mongoose.connection.collection('appearances'),
  };

  const stats = {
    migrated: 0,
    failed: 0,
  };
  let processed = 0;

  function printProgress() {
    const percent = Math.round((processed / candidates.length) * 100);
    console.log(
      `[cloudinary-to-r2] Progress: ${processed}/${candidates.length} (${percent}%) | migrated: ${stats.migrated} | failed: ${stats.failed}`,
    );
  }

  for (const candidate of candidates) {
    const cacheKey = `${candidate.targetFolder}|${candidate.sourceUrl}`;

    try {
      let r2Url = uploadCache.get(cacheKey);

      if (!r2Url) {
        console.log(
          `[cloudinary-to-r2] Uploading ${candidate.docLabel} :: ${candidate.fieldPath}`,
        );
        r2Url = await migrateAsset(
          candidate.sourceUrl,
          candidate.targetFolder,
          uploadFileToR2,
        );
        uploadCache.set(cacheKey, r2Url);
      } else {
        console.log(
          `[cloudinary-to-r2] Reusing upload for ${candidate.docLabel} :: ${candidate.fieldPath}`,
        );
      }

      await collections[candidate.collection].updateOne(
        { _id: new mongoose.Types.ObjectId(candidate.docId) },
        { $set: { [candidate.fieldPath]: r2Url } },
      );

      stats.migrated += 1;
      console.log(`  -> ${r2Url}`);
    } catch (error) {
      stats.failed += 1;
      console.error(
        `[cloudinary-to-r2] Failed for ${candidate.docLabel} :: ${candidate.fieldPath}`,
        error,
      );
    }

    processed += 1;
    printProgress();
  }

  console.log('\n[cloudinary-to-r2] Migration complete');
  console.log(`  migrated: ${stats.migrated}`);
  console.log(`  failed: ${stats.failed}`);
  console.log(`  cached uploads reused: ${uploadCache.size}`);

  await mongoose.disconnect();
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('[cloudinary-to-r2] Fatal error:', error);
    process.exit(1);
  });
