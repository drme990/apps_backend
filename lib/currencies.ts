/**
 * Currency Registry
 *
 * Single source of truth for all currency metadata in the system.
 * Extracted from `backend/scripts/seed-countries.ts` — every currency
 * used by any country in the DB has an entry here.
 *
 * Usage:
 *   import { normalizeCurrencyCode, getCurrencyInfo, getCurrencySymbol } from '@/lib/currencies';
 *
 *   normalizeCurrencyCode('ج.م')   → 'EGP'
 *   normalizeCurrencyCode('egp')   → 'EGP'
 *   getCurrencyInfo('EGP')         → { code, symbol, nameEn, nameAr, decimals }
 *   getCurrencySymbol('EGP')       → 'ج.م'
 *   getCurrencyName('EGP', 'ar')   → 'جنيه مصري'
 */

export interface CurrencyInfo {
  /** ISO 4217 currency code (uppercase, e.g. "EGP") */
  code: string;
  /** Localized symbol (e.g. "ج.م", "$", "€") — matches what's in the DB/seed file */
  symbol: string;
  /** English name (e.g. "Egyptian Pound") */
  nameEn: string;
  /** Arabic name (e.g. "جنيه مصري") */
  nameAr: string;
  /** Number of decimal digits (e.g. 2 for USD, 0 for JPY, 3 for KWD/BHD/OMR/JOD) */
  decimals: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// All currencies used in the system (extracted from seed-countries.ts)
// ─────────────────────────────────────────────────────────────────────────────

export const CURRENCIES: Record<string, CurrencyInfo> = {
  // ── Major / Gateway currencies ──
  USD: { code: 'USD', symbol: '$',   nameEn: 'US Dollar',          nameAr: 'دولار أمريكي',        decimals: 2 },
  EUR: { code: 'EUR', symbol: '€',   nameEn: 'Euro',               nameAr: 'يورو',                decimals: 2 },
  GBP: { code: 'GBP', symbol: '£',   nameEn: 'British Pound',      nameAr: 'جنيه إسترليني',       decimals: 2 },
  SAR: { code: 'SAR', symbol: 'ر.س', nameEn: 'Saudi Riyal',        nameAr: 'ريال سعودي',          decimals: 2 },

  // ── Middle East & North Africa ──
  EGP: { code: 'EGP', symbol: 'ج.م', nameEn: 'Egyptian Pound',     nameAr: 'جنيه مصري',           decimals: 2 },
  KWD: { code: 'KWD', symbol: 'د.ك', nameEn: 'Kuwaiti Dinar',      nameAr: 'دينار كويتي',         decimals: 3 },
  QAR: { code: 'QAR', symbol: 'ر.ق', nameEn: 'Qatari Riyal',       nameAr: 'ريال قطري',           decimals: 2 },
  AED: { code: 'AED', symbol: 'د.إ', nameEn: 'UAE Dirham',         nameAr: 'درهم إماراتي',        decimals: 2 },
  BHD: { code: 'BHD', symbol: 'د.ب', nameEn: 'Bahraini Dinar',     nameAr: 'دينار بحريني',        decimals: 3 },
  JOD: { code: 'JOD', symbol: 'د.أ', nameEn: 'Jordanian Dinar',    nameAr: 'دينار أردني',         decimals: 3 },
  IQD: { code: 'IQD', symbol: 'د.ع', nameEn: 'Iraqi Dinar',        nameAr: 'دينار عراقي',         decimals: 3 },
  OMR: { code: 'OMR', symbol: 'ر.ع', nameEn: 'Omani Rial',         nameAr: 'ريال عماني',          decimals: 3 },
  YER: { code: 'YER', symbol: 'ر.ي', nameEn: 'Yemeni Rial',        nameAr: 'ريال يمني',           decimals: 2 },
  LBP: { code: 'LBP', symbol: 'ل.ل', nameEn: 'Lebanese Pound',     nameAr: 'ليرة لبنانية',        decimals: 2 },
  SYP: { code: 'SYP', symbol: 'ل.س', nameEn: 'Syrian Pound',       nameAr: 'ليرة سورية',          decimals: 2 },
  ILS: { code: 'ILS', symbol: '₪',   nameEn: 'Israeli Shekel',     nameAr: 'شيكل إسرائيلي',       decimals: 2 },
  MAD: { code: 'MAD', symbol: 'د.م', nameEn: 'Moroccan Dirham',    nameAr: 'درهم مغربي',          decimals: 2 },
  TND: { code: 'TND', symbol: 'د.ت', nameEn: 'Tunisian Dinar',     nameAr: 'دينار تونسي',         decimals: 3 },
  DZD: { code: 'DZD', symbol: 'د.ج', nameEn: 'Algerian Dinar',     nameAr: 'دينار جزائري',        decimals: 2 },
  LYD: { code: 'LYD', symbol: 'د.ل', nameEn: 'Libyan Dinar',       nameAr: 'دينار ليبي',          decimals: 3 },
  SDG: { code: 'SDG', symbol: 'ج.س', nameEn: 'Sudanese Pound',     nameAr: 'جنيه سوداني',         decimals: 2 },
  MRU: { code: 'MRU', symbol: 'أ.م', nameEn: 'Mauritanian Ouguiya', nameAr: 'أوقية موريتانية',     decimals: 2 },
  DJF: { code: 'DJF', symbol: 'Fdj', nameEn: 'Djiboutian Franc',   nameAr: 'فرنك جيبوتي',         decimals: 0 },
  KMF: { code: 'KMF', symbol: 'CF',  nameEn: 'Comorian Franc',     nameAr: 'فرنك قمري',           decimals: 0 },

  // ── Turkey & Central Asia ──
  TRY: { code: 'TRY', symbol: '₺',   nameEn: 'Turkish Lira',       nameAr: 'ليرة تركية',          decimals: 2 },
  AZN: { code: 'AZN', symbol: '₼',   nameEn: 'Azerbaijani Manat',  nameAr: 'مانات أذربيجاني',      decimals: 2 },
  KZT: { code: 'KZT', symbol: '₸',   nameEn: 'Kazakhstani Tenge',  nameAr: 'تينغ كازاخستاني',      decimals: 2 },
  UZS: { code: 'UZS', symbol: 'сўм', nameEn: 'Uzbekistani Som',    nameAr: 'سوم أوزبكي',          decimals: 2 },
  TMT: { code: 'TMT', symbol: 'm',   nameEn: 'Turkmenistani Manat', nameAr: 'مانات تركمانستاني',    decimals: 2 },
  KGS: { code: 'KGS', symbol: 'сом', nameEn: 'Kyrgystani Som',     nameAr: 'سوم قيرغيزستاني',      decimals: 2 },
  TJS: { code: 'TJS', symbol: 'SM',  nameEn: 'Tajikistani Somoni', nameAr: 'سوموني طاجيكستاني',    decimals: 2 },
  GEL: { code: 'GEL', symbol: '₾',   nameEn: 'Georgian Lari',      nameAr: 'لاري جورجي',          decimals: 2 },
  AMD: { code: 'AMD', symbol: '֏',   nameEn: 'Armenian Dram',      nameAr: 'درام أرميني',         decimals: 2 },

  // ── South & Southeast Asia ──
  INR: { code: 'INR', symbol: '₹',   nameEn: 'Indian Rupee',       nameAr: 'روبية هندية',          decimals: 2 },
  PKR: { code: 'PKR', symbol: 'Rs',  nameEn: 'Pakistani Rupee',    nameAr: 'روبية باكستانية',      decimals: 2 },
  BDT: { code: 'BDT', symbol: '৳',   nameEn: 'Bangladeshi Taka',   nameAr: 'تاكا بنغلاديشي',       decimals: 2 },
  AFN: { code: 'AFN', symbol: '؋',   nameEn: 'Afghan Afghani',     nameAr: 'أفغاني أفغاني',       decimals: 2 },
  LKR: { code: 'LKR', symbol: 'Rs',  nameEn: 'Sri Lankan Rupee',   nameAr: 'روبية سريلانكية',      decimals: 2 },
  NPR: { code: 'NPR', symbol: 'Rs',  nameEn: 'Nepalese Rupee',     nameAr: 'روبية نيبالية',        decimals: 2 },
  MVR: { code: 'MVR', symbol: 'Rf',  nameEn: 'Maldivian Rufiyaa',  nameAr: 'روفية مالديفية',       decimals: 2 },
  IDR: { code: 'IDR', symbol: 'Rp',  nameEn: 'Indonesian Rupiah',  nameAr: 'روبية إندونيسية',      decimals: 2 },
  MYR: { code: 'MYR', symbol: 'RM',  nameEn: 'Malaysian Ringgit',  nameAr: 'رينغيت ماليزي',        decimals: 2 },
  THB: { code: 'THB', symbol: '฿',   nameEn: 'Thai Baht',          nameAr: 'بات تايلندي',          decimals: 2 },
  PHP: { code: 'PHP', symbol: '₱',   nameEn: 'Philippine Peso',    nameAr: 'بيزو فلبيني',         decimals: 2 },
  VND: { code: 'VND', symbol: '₫',   nameEn: 'Vietnamese Dong',    nameAr: 'دونغ فيتنامي',        decimals: 0 },
  MMK: { code: 'MMK', symbol: 'K',   nameEn: 'Burmese Kyat',       nameAr: 'كيات ميانماري',        decimals: 2 },
  KHR: { code: 'KHR', symbol: '៛',   nameEn: 'Cambodian Riel',     nameAr: 'رييل كمبودي',         decimals: 2 },
  SGD: { code: 'SGD', symbol: 'S$',  nameEn: 'Singapore Dollar',   nameAr: 'دولار سنغافوري',       decimals: 2 },
  BND: { code: 'BND', symbol: 'B$',  nameEn: 'Bruneian Dollar',    nameAr: 'دولار برونايي',        decimals: 2 },

  // ── East Asia ──
  CNY: { code: 'CNY', symbol: '¥',   nameEn: 'Chinese Yuan',       nameAr: 'يوان صيني',           decimals: 2 },
  JPY: { code: 'JPY', symbol: '¥',   nameEn: 'Japanese Yen',       nameAr: 'ين ياباني',           decimals: 0 },
  KRW: { code: 'KRW', symbol: '₩',   nameEn: 'South Korean Won',   nameAr: 'وون كوري جنوبي',       decimals: 0 },
  MNT: { code: 'MNT', symbol: '₮',   nameEn: 'Mongolian Tugrik',   nameAr: 'توغريك منغولي',        decimals: 2 },

  // ── Europe ──
  SEK: { code: 'SEK', symbol: 'kr',  nameEn: 'Swedish Krona',      nameAr: 'كرونة سويدية',         decimals: 2 },
  NOK: { code: 'NOK', symbol: 'kr',  nameEn: 'Norwegian Krone',     nameAr: 'كرونة نرويجية',        decimals: 2 },
  DKK: { code: 'DKK', symbol: 'kr',  nameEn: 'Danish Krone',       nameAr: 'كرونة دنماركية',       decimals: 2 },
  CHF: { code: 'CHF', symbol: 'CHF', nameEn: 'Swiss Franc',        nameAr: 'فرنك سويسري',         decimals: 2 },
  PLN: { code: 'PLN', symbol: 'zł',  nameEn: 'Polish Zloty',       nameAr: 'زلوتي بولندي',         decimals: 2 },
  CZK: { code: 'CZK', symbol: 'Kč',  nameEn: 'Czech Koruna',       nameAr: 'كرونة تشيكية',         decimals: 2 },
  HUF: { code: 'HUF', symbol: 'Ft',  nameEn: 'Hungarian Forint',   nameAr: 'فورنت مجري',          decimals: 2 },
  RON: { code: 'RON', symbol: 'lei', nameEn: 'Romanian Leu',       nameAr: 'ليو روماني',          decimals: 2 },
  BGN: { code: 'BGN', symbol: 'лв',  nameEn: 'Bulgarian Lev',      nameAr: 'ليف بلغاري',          decimals: 2 },
  RSD: { code: 'RSD', symbol: 'din', nameEn: 'Serbian Dinar',      nameAr: 'دينار صربي',          decimals: 2 },
  BAM: { code: 'BAM', symbol: 'KM',  nameEn: 'Bosnian Mark',       nameAr: 'مارك بوسني',          decimals: 2 },
  ALL: { code: 'ALL', symbol: 'L',   nameEn: 'Albanian Lek',       nameAr: 'ليك ألباني',          decimals: 2 },
  MKD: { code: 'MKD', symbol: 'ден', nameEn: 'Macedonian Denar',   nameAr: 'دينار مقدوني',         decimals: 2 },
  RUB: { code: 'RUB', symbol: '₽',   nameEn: 'Russian Ruble',      nameAr: 'روبل روسي',           decimals: 2 },
  UAH: { code: 'UAH', symbol: '₴',   nameEn: 'Ukrainian Hryvnia',  nameAr: 'هريفنيا أوكرانية',     decimals: 2 },
  BYN: { code: 'BYN', symbol: 'Br',  nameEn: 'Belarusian Ruble',   nameAr: 'روبل بيلاروسي',        decimals: 2 },
  MDL: { code: 'MDL', symbol: 'L',   nameEn: 'Moldovan Leu',       nameAr: 'ليو مولدوفي',         decimals: 2 },
  ISK: { code: 'ISK', symbol: 'kr',  nameEn: 'Icelandic Krona',    nameAr: 'كرونة آيسلندية',       decimals: 0 },

  // ── Africa ──
  NGN: { code: 'NGN', symbol: '₦',   nameEn: 'Nigerian Naira',     nameAr: 'نايرا نيجيري',         decimals: 2 },
  ZAR: { code: 'ZAR', symbol: 'R',   nameEn: 'South African Rand', nameAr: 'راند جنوب أفريقي',     decimals: 2 },
  KES: { code: 'KES', symbol: 'KSh', nameEn: 'Kenyan Shilling',    nameAr: 'شلن كيني',            decimals: 2 },
  GHS: { code: 'GHS', symbol: '₵',   nameEn: 'Ghanaian Cedi',      nameAr: 'سيدي غاني',           decimals: 2 },
  TZS: { code: 'TZS', symbol: 'TSh', nameEn: 'Tanzanian Shilling', nameAr: 'شلن تنزاني',          decimals: 2 },
  ETB: { code: 'ETB', symbol: 'Br',  nameEn: 'Ethiopian Birr',     nameAr: 'بير إثيوبي',          decimals: 2 },
  SOS: { code: 'SOS', symbol: 'Sh',  nameEn: 'Somali Shilling',    nameAr: 'شلن صومالي',          decimals: 2 },
  XOF: { code: 'XOF', symbol: 'CFA', nameEn: 'West African CFA Franc', nameAr: 'فرنك غرب أفريقي',  decimals: 0 },
  XAF: { code: 'XAF', symbol: 'FCFA', nameEn: 'Central African CFA Franc', nameAr: 'فرنك وسط أفريقي', decimals: 0 },
  UGX: { code: 'UGX', symbol: 'USh', nameEn: 'Ugandan Shilling',   nameAr: 'شلن أوغندي',          decimals: 0 },
  RWF: { code: 'RWF', symbol: 'RF',  nameEn: 'Rwandan Franc',      nameAr: 'فرنك رواندي',         decimals: 0 },
  MGA: { code: 'MGA', symbol: 'Ar',  nameEn: 'Malagasy Ariary',    nameAr: 'أرياري مدغشقري',       decimals: 2 },
  MZN: { code: 'MZN', symbol: 'MT',  nameEn: 'Mozambican Metical', nameAr: 'ميتيكال موزمبيقي',     decimals: 2 },
  ZMW: { code: 'ZMW', symbol: 'ZK',  nameEn: 'Zambian Kwacha',     nameAr: 'كواشا زامبية',         decimals: 2 },
  ZWL: { code: 'ZWL', symbol: 'Z$',  nameEn: 'Zimbabwean Dollar',  nameAr: 'دولار زيمبابوي',       decimals: 2 },
  GNF: { code: 'GNF', symbol: 'FG',  nameEn: 'Guinean Franc',      nameAr: 'فرنك غيني',           decimals: 0 },
  BWP: { code: 'BWP', symbol: 'P',   nameEn: 'Botswanan Pula',     nameAr: 'بولا بوتسواني',        decimals: 2 },
  NAD: { code: 'NAD', symbol: 'N$',  nameEn: 'Namibian Dollar',    nameAr: 'دولار ناميبي',         decimals: 2 },
  MUR: { code: 'MUR', symbol: 'Rs',  nameEn: 'Mauritian Rupee',    nameAr: 'روبية موريشية',        decimals: 2 },
  MWK: { code: 'MWK', symbol: 'MK',  nameEn: 'Malawian Kwacha',    nameAr: 'كواشا ملاوية',         decimals: 2 },

  // ── Americas ──
  CAD: { code: 'CAD', symbol: 'C$',  nameEn: 'Canadian Dollar',    nameAr: 'دولار كندي',          decimals: 2 },
  MXN: { code: 'MXN', symbol: 'MX$', nameEn: 'Mexican Peso',       nameAr: 'بيزو مكسيكي',         decimals: 2 },
  BRL: { code: 'BRL', symbol: 'R$',  nameEn: 'Brazilian Real',     nameAr: 'ريال برازيلي',         decimals: 2 },
  ARS: { code: 'ARS', symbol: 'AR$', nameEn: 'Argentine Peso',     nameAr: 'بيزو أرجنتيني',        decimals: 2 },
  COP: { code: 'COP', symbol: 'COL$', nameEn: 'Colombian Peso',    nameAr: 'بيزو كولومبي',         decimals: 2 },
  CLP: { code: 'CLP', symbol: 'CL$', nameEn: 'Chilean Peso',       nameAr: 'بيزو تشيلي',          decimals: 0 },
  PEN: { code: 'PEN', symbol: 'S/',  nameEn: 'Peruvian Sol',       nameAr: 'سول بيروفي',          decimals: 2 },
  VES: { code: 'VES', symbol: 'Bs',  nameEn: 'Venezuelan Bolivar', nameAr: 'بوليفار فنزويلي',      decimals: 2 },
  GYD: { code: 'GYD', symbol: 'G$',  nameEn: 'Guyanese Dollar',    nameAr: 'دولار غيانا',         decimals: 2 },
  SRD: { code: 'SRD', symbol: 'SRD', nameEn: 'Surinamese Dollar',  nameAr: 'دولار سورينامي',       decimals: 2 },
  TTD: { code: 'TTD', symbol: 'TT$', nameEn: 'Trinidad Dollar',    nameAr: 'دولار ترينيدادي',      decimals: 2 },

  // ── Oceania ──
  AUD: { code: 'AUD', symbol: 'A$',  nameEn: 'Australian Dollar',  nameAr: 'دولار أسترالي',        decimals: 2 },
  NZD: { code: 'NZD', symbol: 'NZ$', nameEn: 'New Zealand Dollar', nameAr: 'دولار نيوزيلندي',       decimals: 2 },
  FJD: { code: 'FJD', symbol: 'FJ$', nameEn: 'Fijian Dollar',      nameAr: 'دولار فيجي',          decimals: 2 },
  PGK: { code: 'PGK', symbol: 'K',   nameEn: 'Papua New Guinean Kina', nameAr: 'كينا بابوا غينيا',  decimals: 2 },
};

// ─────────────────────────────────────────────────────────────────────────────
// Reverse lookup: symbol → ISO code
// Built automatically from CURRENCIES. Only includes symbols that differ
// from the code itself (e.g. "ج.م" → "EGP", but not "CHF" → "CHF").
// ─────────────────────────────────────────────────────────────────────────────

const SYMBOL_TO_CODE: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  for (const info of Object.values(CURRENCIES)) {
    if (info.symbol && info.symbol !== info.code) {
      map[info.symbol] = info.code;
    }
  }
  return map;
})();

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get currency metadata by ISO code (case-insensitive).
 * Returns null if the code is not in the registry.
 */
export function getCurrencyInfo(code: string): CurrencyInfo | null {
  const upper = code.trim().toUpperCase();
  return CURRENCIES[upper] ?? null;
}

/**
 * Get the display symbol for a currency code.
 * Falls back to the code itself if not found.
 */
export function getCurrencySymbol(code: string): string {
  return getCurrencyInfo(code)?.symbol ?? code.toUpperCase();
}

/**
 * Get the localized name for a currency code.
 * Falls back to the code itself if not found.
 */
export function getCurrencyName(code: string, locale: 'ar' | 'en'): string {
  const info = getCurrencyInfo(code);
  if (!info) return code.toUpperCase();
  return locale === 'ar' ? info.nameAr : info.nameEn;
}

/**
 * Normalize a currency string to an uppercase ISO 4217 code.
 *
 * 1. If the input matches a known localized symbol → map to ISO code
 * 2. Otherwise, use the raw input as-is (assume it's already an ISO code)
 * 3. Fall back to 'SAR' if the input is empty
 * 4. Always uppercase + trim the result
 *
 * This is a safety net — the frontend should always send ISO codes.
 * But if a client sends "ج.م" or "egp", we handle it gracefully.
 */
export function normalizeCurrencyCode(
  raw: string | undefined | null,
): string {
  const trimmed = raw?.trim();
  if (!trimmed) return 'SAR';
  return (SYMBOL_TO_CODE[trimmed] || trimmed).toUpperCase().trim();
}
