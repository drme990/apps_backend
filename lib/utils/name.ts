/**
 * Customer name helpers.
 *
 * EasyKash's payment API validates the `name` field with
 * `onlyNumbersAndCharacters` — anything outside letters, numbers and
 * spaces (punctuation, symbols, emojis, combining marks like Arabic
 * tashkeel) is rejected with a 460 error and the payment link fails.
 *
 * Two helpers:
 *  - `isValidCustomerName`  — strict validation for user input
 *    (checkout, register, settings, manual order forms). Matches the
 *    gateway rule so stored names are always gateway-safe.
 *  - `sanitizeCustomerNameForGateway` — defense-in-depth cleanup applied
 *    right before sending to EasyKash, so orders created before this
 *    validation existed still pay successfully.
 */

/**
 * Characters EasyKash accepts in `name`: Unicode letters, Unicode
 * numbers, and spaces. Anything else (punctuation, symbols, emojis,
 * combining diacritics) is rejected.
 */
const CUSTOMER_NAME_PATTERN = /^[\p{L}\p{N}]+(?:[\p{L}\p{N} ]*[\p{L}\p{N}])?$/u;

/** Fallback when a name becomes empty after stripping. */
const GATEWAY_NAME_FALLBACK = 'Customer';

export function isValidCustomerName(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0 && CUSTOMER_NAME_PATTERN.test(trimmed);
}

/**
 * Strip everything EasyKash rejects:
 *  - combining marks (Arabic tashkeel ً ٌ ٍ َ ُ ِ ّ ْ , Latin accents'
 *    combining forms) — removed after NFD normalization, which turns
 *    e.g. `é` into `e` and drops the accent
 *  - every other non-letter/non-number/non-space char (punctuation,
 *    emojis, underscores, slashes…) → replaced with a space
 *  - whitespace collapsed, ends trimmed
 *
 * Returns a safe fallback when nothing usable remains, so the gateway
 * always receives a non-empty valid name.
 */
export function sanitizeCustomerNameForGateway(value: string): string {
  const cleaned = (value || '')
    .normalize('NFD')
    // Strip combining marks (diacritics, tashkeel)
    .replace(/\p{M}+/gu, '')
    // Any run of characters that aren't letters/numbers/spaces → one space
    .replace(/[^\p{L}\p{N} ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return cleaned || GATEWAY_NAME_FALLBACK;
}
