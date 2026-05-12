export type CountryVisibilityTab = 'realPrice' | 'exchangePrice';

export type CountryVisibilityOptions = {
  realPrice?: boolean;
  exchangePrice?: boolean;
};

export type CountryVisibilityMap = Record<string, CountryVisibilityOptions>;

export type CountryVisibilityMode = 'all' | 'custom';

export interface CountryVisibilityRecord {
  code: string;
  visibilityMode?: CountryVisibilityMode;
  countriesToSee?: unknown;
}

export function normalizeCountryCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const code = raw.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return null;
  if (code === 'XX' || code === 'ZZ') return null;
  return code;
}

function normalizeVisibilityOptions(
  raw: unknown,
): CountryVisibilityOptions | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }

  const value = raw as Record<string, unknown>;

  return {
    realPrice: value.realPrice === true,
    exchangePrice: value.exchangePrice === true,
  };
}

export function normalizeCountryVisibilityMap(
  raw: unknown,
): CountryVisibilityMap {
  if (!raw) return {};

  // legacy array support
  if (Array.isArray(raw)) {
    return raw.reduce<CountryVisibilityMap>((acc, item) => {
      const code = normalizeCountryCode(item);

      if (!code) return acc;

      acc[code] = {
        realPrice: true,
        exchangePrice: false,
      };

      return acc;
    }, {});
  }

  if (typeof raw !== 'object') {
    return {};
  }

  return Object.entries(
    raw as Record<string, unknown>,
  ).reduce<CountryVisibilityMap>((acc, [key, value]) => {
    const code = normalizeCountryCode(key);

    if (!code) return acc;

    const normalized = normalizeVisibilityOptions(value);

    if (!normalized) return acc;

    acc[code] = normalized;

    return acc;
  }, {});
}
export function getVisibleCountriesForViewer<T extends CountryVisibilityRecord>(
  countries: T[],
  viewerCountryCode: string,
): Array<T & { viewerVisibility: CountryVisibilityOptions }> {
  const viewerCode = normalizeCountryCode(viewerCountryCode);
  if (!viewerCode) return [];

  const viewer = countries.find((country) => country.code === viewerCode);
  if (!viewer || (viewer.visibilityMode ?? 'all') === 'all') {
    return countries.map((country) => ({
      ...country,
      viewerVisibility:
        country.code === viewerCode
          ? { realPrice: true, exchangePrice: false }
          : { realPrice: true, exchangePrice: true },
    }));
  }

  const visibleMap = normalizeCountryVisibilityMap(viewer.countriesToSee);

  return countries
    .map((country) => ({
      ...country,
      viewerVisibility:
        country.code === viewerCode
          ? { realPrice: true, exchangePrice: false }
          : visibleMap[country.code],
    }))
    .filter((country) => {
      const visibility = country.viewerVisibility;
      return Boolean(visibility?.realPrice || visibility?.exchangePrice);
    });
}
