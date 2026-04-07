import mongoose, { Document, Types } from 'mongoose';

declare function require(name: string): unknown;
const fs = require('fs') as {
  existsSync: (filePath: string) => boolean;
  readFileSync: (filePath: string, encoding: string) => string;
};
const path = require('path') as {
  join: (...paths: string[]) => string;
};

declare const process: {
  env: Record<string, string | undefined>;
  cwd: () => string;
  argv: string[];
  exit: (code?: number) => never;
};

type ProductPlatform = 'shared' | 'ghadaq' | 'manasik';

type RawMediaEntry =
  | string
  | {
      url?: unknown;
      platform?: unknown;
    };

type ProductDoc = Document & {
  _id: Types.ObjectId;
  media?: RawMediaEntry[];
  images: unknown | undefined;
};

const VALID_PLATFORMS: readonly ProductPlatform[] = [
  'shared',
  'ghadaq',
  'manasik',
] as const;

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
  loadEnvFile(path.join(cwd, '.env'));
  loadEnvFile(path.join(cwd, '.env.local'));
}

function getMongoUri(): string {
  const cliUriArg = process.argv.find((arg) => arg.startsWith('--uri='));
  if (cliUriArg) {
    return cliUriArg.slice('--uri='.length);
  }

  return process.env.DATA_BASE_URL || 'mongodb://localhost:27017/manasik';
}

function toNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizePlatform(value: unknown): ProductPlatform {
  if (
    typeof value === 'string' &&
    VALID_PLATFORMS.includes(value as ProductPlatform)
  ) {
    return value as ProductPlatform;
  }

  return 'shared';
}

function normalizeMedia(
  media: RawMediaEntry[] | undefined,
  images: unknown,
): Array<{ url: string; platform: ProductPlatform }> {
  const source =
    Array.isArray(media) && media.length > 0
      ? media
      : Array.isArray(images)
        ? (images as string[])
        : [];

  const seen = new Set<string>();
  const normalized: Array<{ url: string; platform: ProductPlatform }> = [];

  for (const item of source) {
    if (typeof item === 'string') {
      const url = toNonEmptyString(item);
      if (!url) continue;

      const key = `shared|${url}`;
      if (seen.has(key)) continue;
      seen.add(key);

      normalized.push({ url, platform: 'shared' });
      continue;
    }

    if (!item || typeof item !== 'object') continue;

    const url = toNonEmptyString(item.url);
    if (!url) continue;

    const platform = normalizePlatform(item.platform);
    const key = `${platform}|${url}`;
    if (seen.has(key)) continue;
    seen.add(key);

    normalized.push({ url, platform });
  }

  return normalized;
}

function areMediaEqual(
  a: Array<{ url: string; platform: ProductPlatform }>,
  b: RawMediaEntry[] | undefined,
): boolean {
  if (!Array.isArray(b)) return a.length === 0;

  const normalizedB = normalizeMedia(b, undefined);
  if (a.length !== normalizedB.length) return false;

  return a.every(
    (item, index) =>
      item.url === normalizedB[index]?.url &&
      item.platform === normalizedB[index]?.platform,
  );
}

const ProductSchema = new mongoose.Schema(
  {
    media: [
      {
        url: { type: String },
        platform: { type: String },
      },
    ],
    images: [String],
  },
  { strict: false },
);

const Product =
  (mongoose.models.Product as mongoose.Model<ProductDoc>) ||
  mongoose.model<ProductDoc>('Product', ProductSchema, 'products');

async function migrateProductMedia() {
  const products = await Product.find({}, { media: 1, images: 1 }).lean();

  let scanned = 0;
  let updated = 0;
  let removedLegacyImages = 0;

  for (const product of products) {
    scanned += 1;

    const normalizedMedia = normalizeMedia(product.media, product.images);
    const mediaChanged = !areMediaEqual(normalizedMedia, product.media);
    const hasLegacyImages = Array.isArray(product.images);

    if (!mediaChanged && !hasLegacyImages) {
      continue;
    }

    const updateResult = await Product.updateOne(
      { _id: product._id },
      {
        $set: { media: normalizedMedia },
        $unset: { images: 1 },
      },
    );

    if (updateResult.modifiedCount > 0) {
      updated += 1;
    }

    if (hasLegacyImages) {
      removedLegacyImages += 1;
    }
  }

  return {
    scanned,
    updated,
    removedLegacyImages,
  };
}

async function main() {
  loadEnvFiles();

  const uri = getMongoUri();
  console.log(`[migrate-product-media] Connecting to ${uri}`);
  await mongoose.connect(uri);

  try {
    const result = await migrateProductMedia();
    console.log('[migrate-product-media] Done');
    console.log(`[migrate-product-media] Scanned: ${result.scanned}`);
    console.log(`[migrate-product-media] Updated: ${result.updated}`);
    console.log(
      `[migrate-product-media] Removed legacy images from: ${result.removedLegacyImages}`,
    );
  } finally {
    await mongoose.disconnect();
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('[migrate-product-media] Failed:', error);
    process.exit(1);
  });
