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
  // Map Israel → Palestine everywhere in the app.
  if (code === 'IL') return 'PS';
  // 'UK' is not an ISO alpha-2 code — 'GB' is the canonical one.
  if (code === 'UK') return 'GB';
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
  'iran': 'IR',

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
  'laos': 'LA',

  // East Asia
  'china': 'CN',
  'japan': 'JP',
  'south korea': 'KR',
  'north korea': 'KP',
  'mongolia': 'MN',
  'hong kong': 'HK',
  'taiwan': 'TW',

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
  'andorra': 'AD',

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
  'angola': 'AO',
  'benin': 'BJ',
  'congo (drc)': 'CD',
  'eritrea': 'ER',
  'south sudan': 'SS',

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
  'belize': 'BZ',
  'bolivia': 'BO',
  'costa rica': 'CR',
  'cuba': 'CU',
  'dominican republic': 'DO',
  'el salvador': 'SV',
  'guatemala': 'GT',
  'haiti': 'HT',
  'honduras': 'HN',
  'jamaica': 'JM',
  'nicaragua': 'NI',
  'panama': 'PA',
  'paraguay': 'PY',
  'uruguay': 'UY',

  // Oceania
  'australia': 'AU',
  'new zealand': 'NZ',
  'fiji': 'FJ',
  'papua new guinea': 'PG',
};

// ISO code → canonical English name (long format).
// Single source of truth for display/storage normalization — matches the
// admin panel's COUNTRIES list plus a few codes used only internally.
const COUNTRY_CODE_TO_NAME: Record<string, string> = {
  AF: 'Afghanistan',
  AL: 'Albania',
  DZ: 'Algeria',
  AD: 'Andorra',
  AO: 'Angola',
  AR: 'Argentina',
  AM: 'Armenia',
  AU: 'Australia',
  AT: 'Austria',
  AZ: 'Azerbaijan',
  BH: 'Bahrain',
  BD: 'Bangladesh',
  BY: 'Belarus',
  BE: 'Belgium',
  BZ: 'Belize',
  BJ: 'Benin',
  BO: 'Bolivia',
  BA: 'Bosnia and Herzegovina',
  BW: 'Botswana',
  BR: 'Brazil',
  BN: 'Brunei',
  BG: 'Bulgaria',
  BF: 'Burkina Faso',
  KH: 'Cambodia',
  CM: 'Cameroon',
  CA: 'Canada',
  CL: 'Chile',
  CN: 'China',
  CO: 'Colombia',
  CD: 'Congo (DRC)',
  CR: 'Costa Rica',
  HR: 'Croatia',
  CU: 'Cuba',
  CY: 'Cyprus',
  CZ: 'Czech Republic',
  DK: 'Denmark',
  DJ: 'Djibouti',
  DO: 'Dominican Republic',
  EC: 'Ecuador',
  EG: 'Egypt',
  SV: 'El Salvador',
  ER: 'Eritrea',
  EE: 'Estonia',
  ET: 'Ethiopia',
  FI: 'Finland',
  FR: 'France',
  GE: 'Georgia',
  DE: 'Germany',
  GH: 'Ghana',
  GR: 'Greece',
  GT: 'Guatemala',
  GN: 'Guinea',
  HT: 'Haiti',
  HN: 'Honduras',
  HK: 'Hong Kong',
  HU: 'Hungary',
  IS: 'Iceland',
  IN: 'India',
  ID: 'Indonesia',
  IR: 'Iran',
  IQ: 'Iraq',
  IE: 'Ireland',
  IT: 'Italy',
  JM: 'Jamaica',
  JP: 'Japan',
  JO: 'Jordan',
  KZ: 'Kazakhstan',
  KE: 'Kenya',
  KW: 'Kuwait',
  KG: 'Kyrgyzstan',
  LA: 'Laos',
  LV: 'Latvia',
  LB: 'Lebanon',
  LY: 'Libya',
  LT: 'Lithuania',
  LU: 'Luxembourg',
  MG: 'Madagascar',
  MY: 'Malaysia',
  ML: 'Mali',
  MT: 'Malta',
  MR: 'Mauritania',
  MU: 'Mauritius',
  MX: 'Mexico',
  MD: 'Moldova',
  MN: 'Mongolia',
  ME: 'Montenegro',
  MA: 'Morocco',
  MZ: 'Mozambique',
  MM: 'Myanmar',
  NA: 'Namibia',
  NP: 'Nepal',
  NL: 'Netherlands',
  NZ: 'New Zealand',
  NI: 'Nicaragua',
  NE: 'Niger',
  NG: 'Nigeria',
  KP: 'North Korea',
  MK: 'North Macedonia',
  NO: 'Norway',
  OM: 'Oman',
  PK: 'Pakistan',
  PS: 'Palestine',
  PA: 'Panama',
  PY: 'Paraguay',
  PE: 'Peru',
  PH: 'Philippines',
  PL: 'Poland',
  PT: 'Portugal',
  QA: 'Qatar',
  RO: 'Romania',
  RU: 'Russia',
  RW: 'Rwanda',
  SA: 'Saudi Arabia',
  SN: 'Senegal',
  RS: 'Serbia',
  SG: 'Singapore',
  SK: 'Slovakia',
  SI: 'Slovenia',
  SO: 'Somalia',
  ZA: 'South Africa',
  KR: 'South Korea',
  SS: 'South Sudan',
  ES: 'Spain',
  LK: 'Sri Lanka',
  SD: 'Sudan',
  SE: 'Sweden',
  CH: 'Switzerland',
  SY: 'Syria',
  TW: 'Taiwan',
  TJ: 'Tajikistan',
  TZ: 'Tanzania',
  TH: 'Thailand',
  TN: 'Tunisia',
  TR: 'Turkey',
  TM: 'Turkmenistan',
  UG: 'Uganda',
  UA: 'Ukraine',
  AE: 'United Arab Emirates',
  GB: 'United Kingdom',
  US: 'United States',
  UY: 'Uruguay',
  UZ: 'Uzbekistan',
  VE: 'Venezuela',
  VN: 'Vietnam',
  YE: 'Yemen',
  ZM: 'Zambia',
  ZW: 'Zimbabwe',
  // Codes used only internally (not in the admin selector list)
  XK: 'Kosovo',
  CI: 'Ivory Coast',
  OT: 'Other',
};

export function countryCodeToName(code: string): string | null {
  const normalized = normalizeCountryCode(code);
  if (!normalized) return null;
  return COUNTRY_CODE_TO_NAME[normalized] || null;
}

/**
 * Normalize any country input to the canonical English long name.
 *
 *   'EG' → 'Egypt'   'egypt' → 'Egypt'   'SA'/'saudi' → 'Saudi Arabia'
 *
 * Unknown values are returned trimmed as-is so free-text entries are
 * never silently dropped.
 */
export function normalizeCountryName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const value = raw.trim();
  if (!value) return '';
  // ISO code (or IL→PS) → name
  const code = normalizeCountryCode(value);
  if (code) return COUNTRY_CODE_TO_NAME[code] || value;
  // Name (any casing/alias) → canonical name
  const resolved = countryNameToCode(value);
  if (resolved) return COUNTRY_CODE_TO_NAME[resolved] || value;
  return value;
}

export function countryNameToCode(countryName: string): string | null {
  if (!countryName || typeof countryName !== 'string') return null;

  const normalized = countryName.trim().toLowerCase();

  // If it's already a 2-letter code, return it (map IL → PS)
  if (/^[a-z]{2}$/.test(normalized)) {
    const upper = normalized.toUpperCase();
    if (upper === 'IL') return 'PS';
    if (upper === 'UK') return 'GB';
    return upper;
  }

  // Map 'israel' → 'PS' (Palestine)
  if (normalized === 'israel') return 'PS';

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
  const viewerCode =
    normalizeCountryCode(viewerCountryCode) ??
    countryNameToCode(viewerCountryCode);
  if (!viewerCode) return [];

  // Unsupported viewers (detected country not in the list, e.g. 'SY')
  // are treated as 'OT' (Other): OT becomes their home country, so it
  // gets the self-visibility entry below and OT's visibilityMode /
  // countriesToSee apply. If 'OT' isn't in the list either, fall
  // through to the show-all behavior below.
  let effectiveViewerCode = viewerCode;
  let viewer = countries.find((country) => country.code === viewerCode);
  if (!viewer && viewerCode !== 'OT') {
    const otCountry = countries.find((country) => country.code === 'OT');
    if (otCountry) {
      viewer = otCountry;
      effectiveViewerCode = 'OT';
    }
  }
  if (!viewer || (viewer.visibilityMode ?? 'all') === 'all') {
    return countries.map((country) => ({
      ...country,
      viewerVisibility:
        country.code === effectiveViewerCode
          ? { realPrice: true, exchangePrice: false }
          : { realPrice: true, exchangePrice: true },
    }));
  }

  const visibleMap = normalizeCountryVisibilityMap(viewer.countriesToSee);

  return countries
    .map((country) => ({
      ...country,
      viewerVisibility:
        country.code === effectiveViewerCode
          ? { realPrice: true, exchangePrice: false }
          : visibleMap[country.code],
    }))
    .filter((country) => {
      const visibility = country.viewerVisibility;
      return Boolean(visibility?.realPrice || visibility?.exchangePrice);
    });
}
