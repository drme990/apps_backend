/**
 * Seed script: Populates the database with all world countries.
 *
 * Usage: npx tsx scripts/seed-countries.ts
 *
 * - Existing countries will NOT be modified (preserves current active state).
 * - The original 13 countries are seeded as active.
 * - All new countries are seeded as inactive by default.
 */

import mongoose from 'mongoose';

const MONGODB_URI =
  process.env.DATA_BASE_URL || 'mongodb://localhost:27017/manasik';

if (!MONGODB_URI || MONGODB_URI.trim() === '') {
  console.error('Error: DATA_BASE_URL is not defined in environment variables');
  process.exit(1);
}

// Original active countries — seeded as active
const ACTIVE_CODES = new Set([
  'EG',
  'SA',
  'KW',
  'QA',
  'AE',
  'BH',
  'JO',
  'TR',
  'US',
  'GB',
  'DE',
  'FR',
  'IT',
]);

const countries = [
  // ── Middle East & North Africa ──
  {
    code: 'EG',
    name: { ar: 'مصر', en: 'Egypt' },
    currencyCode: 'EGP',
    currencySymbol: 'ج.م',
    flagEmoji: '🇪🇬',
  },
  {
    code: 'SA',
    name: { ar: 'السعودية', en: 'Saudi Arabia' },
    currencyCode: 'SAR',
    currencySymbol: 'ر.س',
    flagEmoji: '🇸🇦',
  },
  {
    code: 'KW',
    name: { ar: 'الكويت', en: 'Kuwait' },
    currencyCode: 'KWD',
    currencySymbol: 'د.ك',
    flagEmoji: '🇰🇼',
  },
  {
    code: 'QA',
    name: { ar: 'قطر', en: 'Qatar' },
    currencyCode: 'QAR',
    currencySymbol: 'ر.ق',
    flagEmoji: '🇶🇦',
  },
  {
    code: 'AE',
    name: { ar: 'الإمارات', en: 'United Arab Emirates' },
    currencyCode: 'AED',
    currencySymbol: 'د.إ',
    flagEmoji: '🇦🇪',
  },
  {
    code: 'BH',
    name: { ar: 'البحرين', en: 'Bahrain' },
    currencyCode: 'BHD',
    currencySymbol: 'د.ب',
    flagEmoji: '🇧🇭',
  },
  {
    code: 'JO',
    name: { ar: 'الأردن', en: 'Jordan' },
    currencyCode: 'JOD',
    currencySymbol: 'د.أ',
    flagEmoji: '🇯🇴',
  },
  {
    code: 'IQ',
    name: { ar: 'العراق', en: 'Iraq' },
    currencyCode: 'IQD',
    currencySymbol: 'د.ع',
    flagEmoji: '🇮🇶',
  },
  {
    code: 'OM',
    name: { ar: 'عُمان', en: 'Oman' },
    currencyCode: 'OMR',
    currencySymbol: 'ر.ع',
    flagEmoji: '🇴🇲',
  },
  {
    code: 'YE',
    name: { ar: 'اليمن', en: 'Yemen' },
    currencyCode: 'YER',
    currencySymbol: 'ر.ي',
    flagEmoji: '🇾🇪',
  },
  {
    code: 'LB',
    name: { ar: 'لبنان', en: 'Lebanon' },
    currencyCode: 'LBP',
    currencySymbol: 'ل.ل',
    flagEmoji: '🇱🇧',
  },
  {
    code: 'SY',
    name: { ar: 'سوريا', en: 'Syria' },
    currencyCode: 'SYP',
    currencySymbol: 'ل.س',
    flagEmoji: '🇸🇾',
  },
  {
    code: 'PS',
    name: { ar: 'فلسطين', en: 'Palestine' },
    currencyCode: 'ILS',
    currencySymbol: '₪',
    flagEmoji: '🇵🇸',
  },
  {
    code: 'MA',
    name: { ar: 'المغرب', en: 'Morocco' },
    currencyCode: 'MAD',
    currencySymbol: 'د.م',
    flagEmoji: '🇲🇦',
  },
  {
    code: 'TN',
    name: { ar: 'تونس', en: 'Tunisia' },
    currencyCode: 'TND',
    currencySymbol: 'د.ت',
    flagEmoji: '🇹🇳',
  },
  {
    code: 'DZ',
    name: { ar: 'الجزائر', en: 'Algeria' },
    currencyCode: 'DZD',
    currencySymbol: 'د.ج',
    flagEmoji: '🇩🇿',
  },
  {
    code: 'LY',
    name: { ar: 'ليبيا', en: 'Libya' },
    currencyCode: 'LYD',
    currencySymbol: 'د.ل',
    flagEmoji: '🇱🇾',
  },
  {
    code: 'SD',
    name: { ar: 'السودان', en: 'Sudan' },
    currencyCode: 'SDG',
    currencySymbol: 'ج.س',
    flagEmoji: '🇸🇩',
  },
  {
    code: 'MR',
    name: { ar: 'موريتانيا', en: 'Mauritania' },
    currencyCode: 'MRU',
    currencySymbol: 'أ.م',
    flagEmoji: '🇲🇷',
  },
  {
    code: 'DJ',
    name: { ar: 'جيبوتي', en: 'Djibouti' },
    currencyCode: 'DJF',
    currencySymbol: 'Fdj',
    flagEmoji: '🇩🇯',
  },
  {
    code: 'KM',
    name: { ar: 'جزر القمر', en: 'Comoros' },
    currencyCode: 'KMF',
    currencySymbol: 'CF',
    flagEmoji: '🇰🇲',
  },

  // ── Turkey & Central Asia ──
  {
    code: 'TR',
    name: { ar: 'تركيا', en: 'Turkey' },
    currencyCode: 'TRY',
    currencySymbol: '₺',
    flagEmoji: '🇹🇷',
  },
  {
    code: 'AZ',
    name: { ar: 'أذربيجان', en: 'Azerbaijan' },
    currencyCode: 'AZN',
    currencySymbol: '₼',
    flagEmoji: '🇦🇿',
  },
  {
    code: 'KZ',
    name: { ar: 'كازاخستان', en: 'Kazakhstan' },
    currencyCode: 'KZT',
    currencySymbol: '₸',
    flagEmoji: '🇰🇿',
  },
  {
    code: 'UZ',
    name: { ar: 'أوزبكستان', en: 'Uzbekistan' },
    currencyCode: 'UZS',
    currencySymbol: 'сўм',
    flagEmoji: '🇺🇿',
  },
  {
    code: 'TM',
    name: { ar: 'تركمانستان', en: 'Turkmenistan' },
    currencyCode: 'TMT',
    currencySymbol: 'm',
    flagEmoji: '🇹🇲',
  },
  {
    code: 'KG',
    name: { ar: 'قيرغيزستان', en: 'Kyrgyzstan' },
    currencyCode: 'KGS',
    currencySymbol: 'сом',
    flagEmoji: '🇰🇬',
  },
  {
    code: 'TJ',
    name: { ar: 'طاجيكستان', en: 'Tajikistan' },
    currencyCode: 'TJS',
    currencySymbol: 'SM',
    flagEmoji: '🇹🇯',
  },
  {
    code: 'GE',
    name: { ar: 'جورجيا', en: 'Georgia' },
    currencyCode: 'GEL',
    currencySymbol: '₾',
    flagEmoji: '🇬🇪',
  },
  {
    code: 'AM',
    name: { ar: 'أرمينيا', en: 'Armenia' },
    currencyCode: 'AMD',
    currencySymbol: '֏',
    flagEmoji: '🇦🇲',
  },

  // ── South & Southeast Asia ──
  {
    code: 'IN',
    name: { ar: 'الهند', en: 'India' },
    currencyCode: 'INR',
    currencySymbol: '₹',
    flagEmoji: '🇮🇳',
  },
  {
    code: 'PK',
    name: { ar: 'باكستان', en: 'Pakistan' },
    currencyCode: 'PKR',
    currencySymbol: 'Rs',
    flagEmoji: '🇵🇰',
  },
  {
    code: 'BD',
    name: { ar: 'بنغلاديش', en: 'Bangladesh' },
    currencyCode: 'BDT',
    currencySymbol: '৳',
    flagEmoji: '🇧🇩',
  },
  {
    code: 'AF',
    name: { ar: 'أفغانستان', en: 'Afghanistan' },
    currencyCode: 'AFN',
    currencySymbol: '؋',
    flagEmoji: '🇦🇫',
  },
  {
    code: 'LK',
    name: { ar: 'سريلانكا', en: 'Sri Lanka' },
    currencyCode: 'LKR',
    currencySymbol: 'Rs',
    flagEmoji: '🇱🇰',
  },
  {
    code: 'NP',
    name: { ar: 'نيبال', en: 'Nepal' },
    currencyCode: 'NPR',
    currencySymbol: 'Rs',
    flagEmoji: '🇳🇵',
  },
  {
    code: 'MV',
    name: { ar: 'المالديف', en: 'Maldives' },
    currencyCode: 'MVR',
    currencySymbol: 'Rf',
    flagEmoji: '🇲🇻',
  },
  {
    code: 'ID',
    name: { ar: 'إندونيسيا', en: 'Indonesia' },
    currencyCode: 'IDR',
    currencySymbol: 'Rp',
    flagEmoji: '🇮🇩',
  },
  {
    code: 'MY',
    name: { ar: 'ماليزيا', en: 'Malaysia' },
    currencyCode: 'MYR',
    currencySymbol: 'RM',
    flagEmoji: '🇲🇾',
  },
  {
    code: 'TH',
    name: { ar: 'تايلاند', en: 'Thailand' },
    currencyCode: 'THB',
    currencySymbol: '฿',
    flagEmoji: '🇹🇭',
  },
  {
    code: 'PH',
    name: { ar: 'الفلبين', en: 'Philippines' },
    currencyCode: 'PHP',
    currencySymbol: '₱',
    flagEmoji: '🇵🇭',
  },
  {
    code: 'VN',
    name: { ar: 'فيتنام', en: 'Vietnam' },
    currencyCode: 'VND',
    currencySymbol: '₫',
    flagEmoji: '🇻🇳',
  },
  {
    code: 'MM',
    name: { ar: 'ميانمار', en: 'Myanmar' },
    currencyCode: 'MMK',
    currencySymbol: 'K',
    flagEmoji: '🇲🇲',
  },
  {
    code: 'KH',
    name: { ar: 'كمبوديا', en: 'Cambodia' },
    currencyCode: 'KHR',
    currencySymbol: '៛',
    flagEmoji: '🇰🇭',
  },
  {
    code: 'SG',
    name: { ar: 'سنغافورة', en: 'Singapore' },
    currencyCode: 'SGD',
    currencySymbol: 'S$',
    flagEmoji: '🇸🇬',
  },
  {
    code: 'BN',
    name: { ar: 'بروناي', en: 'Brunei' },
    currencyCode: 'BND',
    currencySymbol: 'B$',
    flagEmoji: '🇧🇳',
  },

  // ── East Asia ──
  {
    code: 'CN',
    name: { ar: 'الصين', en: 'China' },
    currencyCode: 'CNY',
    currencySymbol: '¥',
    flagEmoji: '🇨🇳',
  },
  {
    code: 'JP',
    name: { ar: 'اليابان', en: 'Japan' },
    currencyCode: 'JPY',
    currencySymbol: '¥',
    flagEmoji: '🇯🇵',
  },
  {
    code: 'KR',
    name: { ar: 'كوريا الجنوبية', en: 'South Korea' },
    currencyCode: 'KRW',
    currencySymbol: '₩',
    flagEmoji: '🇰🇷',
  },
  {
    code: 'MN',
    name: { ar: 'منغوليا', en: 'Mongolia' },
    currencyCode: 'MNT',
    currencySymbol: '₮',
    flagEmoji: '🇲🇳',
  },

  // ── Europe ──
  {
    code: 'US',
    name: { ar: 'الولايات المتحدة', en: 'United States' },
    currencyCode: 'USD',
    currencySymbol: '$',
    flagEmoji: '🇺🇸',
  },
  {
    code: 'GB',
    name: { ar: 'بريطانيا', en: 'United Kingdom' },
    currencyCode: 'GBP',
    currencySymbol: '£',
    flagEmoji: '🇬🇧',
  },
  {
    code: 'DE',
    name: { ar: 'ألمانيا', en: 'Germany' },
    currencyCode: 'EUR',
    currencySymbol: '€',
    flagEmoji: '🇩🇪',
  },
  {
    code: 'FR',
    name: { ar: 'فرنسا', en: 'France' },
    currencyCode: 'EUR',
    currencySymbol: '€',
    flagEmoji: '🇫🇷',
  },
  {
    code: 'IT',
    name: { ar: 'إيطاليا', en: 'Italy' },
    currencyCode: 'EUR',
    currencySymbol: '€',
    flagEmoji: '🇮🇹',
  },
  {
    code: 'ES',
    name: { ar: 'إسبانيا', en: 'Spain' },
    currencyCode: 'EUR',
    currencySymbol: '€',
    flagEmoji: '🇪🇸',
  },
  {
    code: 'NL',
    name: { ar: 'هولندا', en: 'Netherlands' },
    currencyCode: 'EUR',
    currencySymbol: '€',
    flagEmoji: '🇳🇱',
  },
  {
    code: 'BE',
    name: { ar: 'بلجيكا', en: 'Belgium' },
    currencyCode: 'EUR',
    currencySymbol: '€',
    flagEmoji: '🇧🇪',
  },
  {
    code: 'AT',
    name: { ar: 'النمسا', en: 'Austria' },
    currencyCode: 'EUR',
    currencySymbol: '€',
    flagEmoji: '🇦🇹',
  },
  {
    code: 'GR',
    name: { ar: 'اليونان', en: 'Greece' },
    currencyCode: 'EUR',
    currencySymbol: '€',
    flagEmoji: '🇬🇷',
  },
  {
    code: 'PT',
    name: { ar: 'البرتغال', en: 'Portugal' },
    currencyCode: 'EUR',
    currencySymbol: '€',
    flagEmoji: '🇵🇹',
  },
  {
    code: 'IE',
    name: { ar: 'أيرلندا', en: 'Ireland' },
    currencyCode: 'EUR',
    currencySymbol: '€',
    flagEmoji: '🇮🇪',
  },
  {
    code: 'FI',
    name: { ar: 'فنلندا', en: 'Finland' },
    currencyCode: 'EUR',
    currencySymbol: '€',
    flagEmoji: '🇫🇮',
  },
  {
    code: 'SE',
    name: { ar: 'السويد', en: 'Sweden' },
    currencyCode: 'SEK',
    currencySymbol: 'kr',
    flagEmoji: '🇸🇪',
  },
  {
    code: 'NO',
    name: { ar: 'النرويج', en: 'Norway' },
    currencyCode: 'NOK',
    currencySymbol: 'kr',
    flagEmoji: '🇳🇴',
  },
  {
    code: 'DK',
    name: { ar: 'الدنمارك', en: 'Denmark' },
    currencyCode: 'DKK',
    currencySymbol: 'kr',
    flagEmoji: '🇩🇰',
  },
  {
    code: 'CH',
    name: { ar: 'سويسرا', en: 'Switzerland' },
    currencyCode: 'CHF',
    currencySymbol: 'CHF',
    flagEmoji: '🇨🇭',
  },
  {
    code: 'PL',
    name: { ar: 'بولندا', en: 'Poland' },
    currencyCode: 'PLN',
    currencySymbol: 'zł',
    flagEmoji: '🇵🇱',
  },
  {
    code: 'CZ',
    name: { ar: 'التشيك', en: 'Czech Republic' },
    currencyCode: 'CZK',
    currencySymbol: 'Kč',
    flagEmoji: '🇨🇿',
  },
  {
    code: 'HU',
    name: { ar: 'المجر', en: 'Hungary' },
    currencyCode: 'HUF',
    currencySymbol: 'Ft',
    flagEmoji: '🇭🇺',
  },
  {
    code: 'RO',
    name: { ar: 'رومانيا', en: 'Romania' },
    currencyCode: 'RON',
    currencySymbol: 'lei',
    flagEmoji: '🇷🇴',
  },
  {
    code: 'BG',
    name: { ar: 'بلغاريا', en: 'Bulgaria' },
    currencyCode: 'BGN',
    currencySymbol: 'лв',
    flagEmoji: '🇧🇬',
  },
  {
    code: 'HR',
    name: { ar: 'كرواتيا', en: 'Croatia' },
    currencyCode: 'EUR',
    currencySymbol: '€',
    flagEmoji: '🇭🇷',
  },
  {
    code: 'RS',
    name: { ar: 'صربيا', en: 'Serbia' },
    currencyCode: 'RSD',
    currencySymbol: 'din',
    flagEmoji: '🇷🇸',
  },
  {
    code: 'BA',
    name: { ar: 'البوسنة والهرسك', en: 'Bosnia and Herzegovina' },
    currencyCode: 'BAM',
    currencySymbol: 'KM',
    flagEmoji: '🇧🇦',
  },
  {
    code: 'AL',
    name: { ar: 'ألبانيا', en: 'Albania' },
    currencyCode: 'ALL',
    currencySymbol: 'L',
    flagEmoji: '🇦🇱',
  },
  {
    code: 'XK',
    name: { ar: 'كوسوفو', en: 'Kosovo' },
    currencyCode: 'EUR',
    currencySymbol: '€',
    flagEmoji: '🇽🇰',
  },
  {
    code: 'MK',
    name: { ar: 'مقدونيا الشمالية', en: 'North Macedonia' },
    currencyCode: 'MKD',
    currencySymbol: 'ден',
    flagEmoji: '🇲🇰',
  },
  {
    code: 'ME',
    name: { ar: 'الجبل الأسود', en: 'Montenegro' },
    currencyCode: 'EUR',
    currencySymbol: '€',
    flagEmoji: '🇲🇪',
  },
  {
    code: 'SI',
    name: { ar: 'سلوفينيا', en: 'Slovenia' },
    currencyCode: 'EUR',
    currencySymbol: '€',
    flagEmoji: '🇸🇮',
  },
  {
    code: 'SK',
    name: { ar: 'سلوفاكيا', en: 'Slovakia' },
    currencyCode: 'EUR',
    currencySymbol: '€',
    flagEmoji: '🇸🇰',
  },
  {
    code: 'LT',
    name: { ar: 'ليتوانيا', en: 'Lithuania' },
    currencyCode: 'EUR',
    currencySymbol: '€',
    flagEmoji: '🇱🇹',
  },
  {
    code: 'LV',
    name: { ar: 'لاتفيا', en: 'Latvia' },
    currencyCode: 'EUR',
    currencySymbol: '€',
    flagEmoji: '🇱🇻',
  },
  {
    code: 'EE',
    name: { ar: 'إستونيا', en: 'Estonia' },
    currencyCode: 'EUR',
    currencySymbol: '€',
    flagEmoji: '🇪🇪',
  },
  {
    code: 'RU',
    name: { ar: 'روسيا', en: 'Russia' },
    currencyCode: 'RUB',
    currencySymbol: '₽',
    flagEmoji: '🇷🇺',
  },
  {
    code: 'UA',
    name: { ar: 'أوكرانيا', en: 'Ukraine' },
    currencyCode: 'UAH',
    currencySymbol: '₴',
    flagEmoji: '🇺🇦',
  },
  {
    code: 'BY',
    name: { ar: 'بيلاروسيا', en: 'Belarus' },
    currencyCode: 'BYN',
    currencySymbol: 'Br',
    flagEmoji: '🇧🇾',
  },
  {
    code: 'MD',
    name: { ar: 'مولدوفا', en: 'Moldova' },
    currencyCode: 'MDL',
    currencySymbol: 'L',
    flagEmoji: '🇲🇩',
  },
  {
    code: 'IS',
    name: { ar: 'آيسلندا', en: 'Iceland' },
    currencyCode: 'ISK',
    currencySymbol: 'kr',
    flagEmoji: '🇮🇸',
  },
  {
    code: 'CY',
    name: { ar: 'قبرص', en: 'Cyprus' },
    currencyCode: 'EUR',
    currencySymbol: '€',
    flagEmoji: '🇨🇾',
  },
  {
    code: 'MT',
    name: { ar: 'مالطا', en: 'Malta' },
    currencyCode: 'EUR',
    currencySymbol: '€',
    flagEmoji: '🇲🇹',
  },
  {
    code: 'LU',
    name: { ar: 'لوكسمبورغ', en: 'Luxembourg' },
    currencyCode: 'EUR',
    currencySymbol: '€',
    flagEmoji: '🇱🇺',
  },

  // ── Africa ──
  {
    code: 'NG',
    name: { ar: 'نيجيريا', en: 'Nigeria' },
    currencyCode: 'NGN',
    currencySymbol: '₦',
    flagEmoji: '🇳🇬',
  },
  {
    code: 'ZA',
    name: { ar: 'جنوب أفريقيا', en: 'South Africa' },
    currencyCode: 'ZAR',
    currencySymbol: 'R',
    flagEmoji: '🇿🇦',
  },
  {
    code: 'KE',
    name: { ar: 'كينيا', en: 'Kenya' },
    currencyCode: 'KES',
    currencySymbol: 'KSh',
    flagEmoji: '🇰🇪',
  },
  {
    code: 'GH',
    name: { ar: 'غانا', en: 'Ghana' },
    currencyCode: 'GHS',
    currencySymbol: '₵',
    flagEmoji: '🇬🇭',
  },
  {
    code: 'TZ',
    name: { ar: 'تنزانيا', en: 'Tanzania' },
    currencyCode: 'TZS',
    currencySymbol: 'TSh',
    flagEmoji: '🇹🇿',
  },
  {
    code: 'ET',
    name: { ar: 'إثيوبيا', en: 'Ethiopia' },
    currencyCode: 'ETB',
    currencySymbol: 'Br',
    flagEmoji: '🇪🇹',
  },
  {
    code: 'SO',
    name: { ar: 'الصومال', en: 'Somalia' },
    currencyCode: 'SOS',
    currencySymbol: 'Sh',
    flagEmoji: '🇸🇴',
  },
  {
    code: 'SN',
    name: { ar: 'السنغال', en: 'Senegal' },
    currencyCode: 'XOF',
    currencySymbol: 'CFA',
    flagEmoji: '🇸🇳',
  },
  {
    code: 'CM',
    name: { ar: 'الكاميرون', en: 'Cameroon' },
    currencyCode: 'XAF',
    currencySymbol: 'FCFA',
    flagEmoji: '🇨🇲',
  },
  {
    code: 'CI',
    name: { ar: 'ساحل العاج', en: 'Ivory Coast' },
    currencyCode: 'XOF',
    currencySymbol: 'CFA',
    flagEmoji: '🇨🇮',
  },
  {
    code: 'UG',
    name: { ar: 'أوغندا', en: 'Uganda' },
    currencyCode: 'UGX',
    currencySymbol: 'USh',
    flagEmoji: '🇺🇬',
  },
  {
    code: 'RW',
    name: { ar: 'رواندا', en: 'Rwanda' },
    currencyCode: 'RWF',
    currencySymbol: 'RF',
    flagEmoji: '🇷🇼',
  },
  {
    code: 'ML',
    name: { ar: 'مالي', en: 'Mali' },
    currencyCode: 'XOF',
    currencySymbol: 'CFA',
    flagEmoji: '🇲🇱',
  },
  {
    code: 'NE',
    name: { ar: 'النيجر', en: 'Niger' },
    currencyCode: 'XOF',
    currencySymbol: 'CFA',
    flagEmoji: '🇳🇪',
  },
  {
    code: 'TD',
    name: { ar: 'تشاد', en: 'Chad' },
    currencyCode: 'XAF',
    currencySymbol: 'FCFA',
    flagEmoji: '🇹🇩',
  },
  {
    code: 'MG',
    name: { ar: 'مدغشقر', en: 'Madagascar' },
    currencyCode: 'MGA',
    currencySymbol: 'Ar',
    flagEmoji: '🇲🇬',
  },
  {
    code: 'MZ',
    name: { ar: 'موزمبيق', en: 'Mozambique' },
    currencyCode: 'MZN',
    currencySymbol: 'MT',
    flagEmoji: '🇲🇿',
  },
  {
    code: 'ZM',
    name: { ar: 'زامبيا', en: 'Zambia' },
    currencyCode: 'ZMW',
    currencySymbol: 'ZK',
    flagEmoji: '🇿🇲',
  },
  {
    code: 'ZW',
    name: { ar: 'زيمبابوي', en: 'Zimbabwe' },
    currencyCode: 'ZWL',
    currencySymbol: 'Z$',
    flagEmoji: '🇿🇼',
  },
  {
    code: 'BF',
    name: { ar: 'بوركينا فاسو', en: 'Burkina Faso' },
    currencyCode: 'XOF',
    currencySymbol: 'CFA',
    flagEmoji: '🇧🇫',
  },
  {
    code: 'GN',
    name: { ar: 'غينيا', en: 'Guinea' },
    currencyCode: 'GNF',
    currencySymbol: 'FG',
    flagEmoji: '🇬🇳',
  },
  {
    code: 'BW',
    name: { ar: 'بوتسوانا', en: 'Botswana' },
    currencyCode: 'BWP',
    currencySymbol: 'P',
    flagEmoji: '🇧🇼',
  },
  {
    code: 'NA',
    name: { ar: 'ناميبيا', en: 'Namibia' },
    currencyCode: 'NAD',
    currencySymbol: 'N$',
    flagEmoji: '🇳🇦',
  },
  {
    code: 'MU',
    name: { ar: 'موريشيوس', en: 'Mauritius' },
    currencyCode: 'MUR',
    currencySymbol: 'Rs',
    flagEmoji: '🇲🇺',
  },

  // ── Americas ──
  {
    code: 'CA',
    name: { ar: 'كندا', en: 'Canada' },
    currencyCode: 'CAD',
    currencySymbol: 'C$',
    flagEmoji: '🇨🇦',
  },
  {
    code: 'MX',
    name: { ar: 'المكسيك', en: 'Mexico' },
    currencyCode: 'MXN',
    currencySymbol: 'MX$',
    flagEmoji: '🇲🇽',
  },
  {
    code: 'BR',
    name: { ar: 'البرازيل', en: 'Brazil' },
    currencyCode: 'BRL',
    currencySymbol: 'R$',
    flagEmoji: '🇧🇷',
  },
  {
    code: 'AR',
    name: { ar: 'الأرجنتين', en: 'Argentina' },
    currencyCode: 'ARS',
    currencySymbol: 'AR$',
    flagEmoji: '🇦🇷',
  },
  {
    code: 'CO',
    name: { ar: 'كولومبيا', en: 'Colombia' },
    currencyCode: 'COP',
    currencySymbol: 'COL$',
    flagEmoji: '🇨🇴',
  },
  {
    code: 'CL',
    name: { ar: 'تشيلي', en: 'Chile' },
    currencyCode: 'CLP',
    currencySymbol: 'CL$',
    flagEmoji: '🇨🇱',
  },
  {
    code: 'PE',
    name: { ar: 'بيرو', en: 'Peru' },
    currencyCode: 'PEN',
    currencySymbol: 'S/',
    flagEmoji: '🇵🇪',
  },
  {
    code: 'VE',
    name: { ar: 'فنزويلا', en: 'Venezuela' },
    currencyCode: 'VES',
    currencySymbol: 'Bs',
    flagEmoji: '🇻🇪',
  },
  {
    code: 'EC',
    name: { ar: 'الإكوادور', en: 'Ecuador' },
    currencyCode: 'USD',
    currencySymbol: '$',
    flagEmoji: '🇪🇨',
  },
  {
    code: 'GY',
    name: { ar: 'غيانا', en: 'Guyana' },
    currencyCode: 'GYD',
    currencySymbol: 'G$',
    flagEmoji: '🇬🇾',
  },
  {
    code: 'SR',
    name: { ar: 'سورينام', en: 'Suriname' },
    currencyCode: 'SRD',
    currencySymbol: 'SRD',
    flagEmoji: '🇸🇷',
  },
  {
    code: 'TT',
    name: { ar: 'ترينيداد وتوباغو', en: 'Trinidad and Tobago' },
    currencyCode: 'TTD',
    currencySymbol: 'TT$',
    flagEmoji: '🇹🇹',
  },

  // ── Oceania ──
  {
    code: 'AU',
    name: { ar: 'أستراليا', en: 'Australia' },
    currencyCode: 'AUD',
    currencySymbol: 'A$',
    flagEmoji: '🇦🇺',
  },
  {
    code: 'NZ',
    name: { ar: 'نيوزيلندا', en: 'New Zealand' },
    currencyCode: 'NZD',
    currencySymbol: 'NZ$',
    flagEmoji: '🇳🇿',
  },
  {
    code: 'FJ',
    name: { ar: 'فيجي', en: 'Fiji' },
    currencyCode: 'FJD',
    currencySymbol: 'FJ$',
    flagEmoji: '🇫🇯',
  },
  {
    code: 'PG',
    name: { ar: 'بابوا غينيا الجديدة', en: 'Papua New Guinea' },
    currencyCode: 'PGK',
    currencySymbol: 'K',
    flagEmoji: '🇵🇬',
  },
];

async function seed() {
  console.log('🌍 Connecting to database...');
  await mongoose.connect(MONGODB_URI!);

  // Import model after connection
  const { default: Country } = await import('../lib/models/Country');

  console.log('🌱 Seeding countries...');

  let created = 0;
  let skipped = 0;

  for (const country of countries) {
    const existing = await Country.findOne({ code: country.code });
    if (existing) {
      console.log(
        `  ⏭️  ${country.code} (${country.name.en}) already exists, skipping.`,
      );
      skipped++;
      continue;
    }

    const isActive = ACTIVE_CODES.has(country.code);
    await Country.create({ ...country, isActive });
    console.log(
      `  ✅ ${country.code} (${country.name.en}) created${isActive ? ' [ACTIVE]' : ''}.`,
    );
    created++;
  }

  console.log(
    `\n✨ Done! ${created} countries created, ${skipped} skipped. Total: ${countries.length} countries.`,
  );
  await mongoose.disconnect();
  process.exit(0);
}

seed().catch((err) => {
  console.error('❌ Seed failed:', err);
  process.exit(1);
});
