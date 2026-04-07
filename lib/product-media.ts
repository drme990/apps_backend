export type ProductPlatform = 'ghadaq' | 'manasik';
export type ProductMediaPlatform = 'shared' | ProductPlatform;

export interface ProductMediaItem {
  url: string;
  platform: ProductMediaPlatform;
}

const VALID_MEDIA_PLATFORMS: readonly ProductMediaPlatform[] = [
  'shared',
  'ghadaq',
  'manasik',
] as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function toNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizePlatform(value: unknown): ProductMediaPlatform {
  if (
    typeof value === 'string' &&
    VALID_MEDIA_PLATFORMS.includes(value as ProductMediaPlatform)
  ) {
    return value as ProductMediaPlatform;
  }

  return 'shared';
}

function normalizeMediaEntry(entry: unknown): ProductMediaItem | null {
  if (typeof entry === 'string') {
    const url = toNonEmptyString(entry);
    return url ? { url, platform: 'shared' } : null;
  }

  if (!isObject(entry)) return null;

  const url = toNonEmptyString(entry.url);
  if (!url) return null;

  return {
    url,
    platform: normalizePlatform(entry.platform),
  };
}

export function normalizeProductMedia(rawMedia: unknown): ProductMediaItem[] {
  const source = Array.isArray(rawMedia) ? rawMedia : [];

  const seen = new Set<string>();
  const normalized: ProductMediaItem[] = [];

  for (const item of source) {
    const media = normalizeMediaEntry(item);
    if (!media) continue;

    const dedupeKey = `${media.platform}|${media.url}`;
    if (seen.has(dedupeKey)) continue;

    seen.add(dedupeKey);
    normalized.push(media);
  }

  return normalized;
}

export function filterProductMediaForPlatform(
  media: ProductMediaItem[],
  platform?: ProductPlatform,
): ProductMediaItem[] {
  if (!platform) return media;

  return media.filter(
    (item) => item.platform === 'shared' || item.platform === platform,
  );
}

export function parseProductPlatform(
  value: string | null | undefined,
): ProductPlatform | undefined {
  if (value === 'ghadaq' || value === 'manasik') {
    return value;
  }

  return undefined;
}
