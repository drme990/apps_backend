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

// Country name to ISO code mapping (all countries from seed-countries.ts)
const COUNTRY_NAME_TO_CODE: Record<string, string> = {
  // Other
  'other': 'OT',
  
  // Middle East & North Africa
  'egypt': 'EG',
  'saudi arabia': 'SA',
  'saudi': 'SA',
  'kuwait': 'KW',
  'qatar': 'QA',
  'united arab emirates': 'AE',
  'uae': 'AE',
  'bahrain': 'BH',
  'jordan': 'JO',
  'iraq': 'IQ',
  'oman': 'OM',
  'yemen': 'YE',
  'lebanon': 'LB',
  'syria': 'SY',
  'palestine': 'PS',
  'morocco': 'MA',
  'tunisia': 'TN',
  'algeria': 'DZ',
  'malawi': 'MW',
  'libya': 'LY',
  'sudan': 'SD',
  'mauritania': 'MR',
  'djibouti': 'DJ',
  'comoros': 'KM',
  
  // Turkey & Central Asia
  'turkey': 'TR',
  'azerbaijan': 'AZ',
  'kazakhstan': 'KZ',
  'uzbekistan': 'UZ',
  'turkmenistan': 'TM',
  'kyrgyzstan': 'KG',
  'tajikistan': 'TJ',
  'georgia': 'GE',
  'armenia': 'AM',
  
  // South & Southeast Asia
  'india': 'IN',
  'pakistan': 'PK',
  'bangladesh': 'BD',
  'afghanistan': 'AF',
  'sri lanka': 'LK',
  'nepal': 'NP',
  'maldives': 'MV',
  'indonesia': 'ID',
  'malaysia': 'MY',
  'thailand': 'TH',
  'philippines': 'PH',
  'vietnam': 'VN',
  'myanmar': 'MM',
  'cambodia': 'KH',
  'singapore': 'SG',
  'brunei': 'BN',
  
  // East Asia
  'china': 'CN',
  'japan': 'JP',
  'south korea': 'KR',
  'mongolia': 'MN',
  
  // Europe
  'united states': 'US',
  'usa': 'US',
  'united kingdom': 'GB',
  'uk': 'GB',
  'germany': 'DE',
  'france': 'FR',
  'italy': 'IT',
  'spain': 'ES',
  'netherlands': 'NL',
  'belgium': 'BE',
  'austria': 'AT',
  'greece': 'GR',
  'portugal': 'PT',
  'ireland': 'IE',
  'finland': 'FI',
  'sweden': 'SE',
  'norway': 'NO',
  'denmark': 'DK',
  'switzerland': 'CH',
  'poland': 'PL',
  'czech republic': 'CZ',
  'czechia': 'CZ',
  'hungary': 'HU',
  'romania': 'RO',
  'bulgaria': 'BG',
  'croatia': 'HR',
  'serbia': 'RS',
  'bosnia and herzegovina': 'BA',
  'albania': 'AL',
  'kosovo': 'XK',
  'north macedonia': 'MK',
  'macedonia': 'MK',
  'montenegro': 'ME',
  'slovenia': 'SI',
  'slovakia': 'SK',
  'lithuania': 'LT',
  'latvia': 'LV',
  'estonia': 'EE',
  'russia': 'RU',
  'ukraine': 'UA',
  'belarus': 'BY',
  'moldova': 'MD',
  'iceland': 'IS',
  'cyprus': 'CY',
  'malta': 'MT',
  'luxembourg': 'LU',
  
  // Africa
  'nigeria': 'NG',
  'south africa': 'ZA',
  'kenya': 'KE',
  'ghana': 'GH',
  'tanzania': 'TZ',
  'ethiopia': 'ET',
  'somalia': 'SO',
  'senegal': 'SN',
  'cameroon': 'CM',
  'ivory coast': 'CI',
  'cote divoire': 'CI',
  'uganda': 'UG',
  'rwanda': 'RW',
  'mali': 'ML',
  'niger': 'NE',
  'chad': 'TD',
  'madagascar': 'MG',
  'mozambique': 'MZ',
  'zambia': 'ZM',
  'zimbabwe': 'ZW',
  'burkina faso': 'BF',
  'guinea': 'GN',
  'botswana': 'BW',
  'namibia': 'NA',
  'mauritius': 'MU',
  
  // Americas
  'canada': 'CA',
  'mexico': 'MX',
  'brazil': 'BR',
  'argentina': 'AR',
  'colombia': 'CO',
  'chile': 'CL',
  'peru': 'PE',
  'venezuela': 'VE',
  'ecuador': 'EC',
  'guyana': 'GY',
  'suriname': 'SR',
  'trinidad and tobago': 'TT',
  
  // Oceania
  'australia': 'AU',
  'new zealand': 'NZ',
  'fiji': 'FJ',
  'papua new guinea': 'PG',
};

export function countryNameToCode(countryName: string): string | null {
  if (!countryName || typeof countryName !== 'string') return null;
  
  const normalized = countryName.trim().toLowerCase();
  
  // If it's already a 2-letter code, return it
  if (/^[a-z]{2}$/.test(normalized)) {
    return normalized.toUpperCase();
  }
  
  // Look up in the mapping
  const code = COUNTRY_NAME_TO_CODE[normalized];
  if (code) return code;
  
  return null;
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
