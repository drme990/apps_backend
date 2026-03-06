/**
 * Currency-specific rounding rules for auto-calculated prices.
 *
 * - 'nearest-ten':  round UP to the nearest 10  (e.g. 4→10, 11→20, 30→30)
 * - 'nearest-five': round UP to the nearest 5   (e.g. 2→5, 6→10, 15→15)
 * - 'ceil':         Math.ceil – round UP to the nearest integer (default)
 *
 * Currencies not listed here fall back to 'ceil'.
 * Add new entries as needed — the key is the uppercase ISO 4217 code.
 */

export type RoundingRule = 'nearest-ten' | 'nearest-five' | 'ceil';

const CURRENCY_ROUNDING: Record<string, RoundingRule> = {
  // Round to nearest 10
  EGP: 'nearest-ten',

  // Round to nearest 5
  SAR: 'nearest-five',
  QAR: 'nearest-five',
  USD: 'nearest-five',
  EUR: 'nearest-five',
  TRY: 'nearest-five',
};

/** Apply the rounding rule for the given currency code. */
export function roundPrice(amount: number, currencyCode: string): number {
  const rule = CURRENCY_ROUNDING[currencyCode.toUpperCase()] ?? 'ceil';

  switch (rule) {
    case 'nearest-ten':
      return Math.ceil(amount / 10) * 10;
    case 'nearest-five':
      return Math.ceil(amount / 5) * 5;
    case 'ceil':
    default:
      return Math.ceil(amount);
  }
}
