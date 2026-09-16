import crypto from 'crypto';
import { countryNameToCode } from '../country-visibility';

/**
 * Shared helpers for the Conversions API services (Meta, TikTok,
 * OpenAI, Snapchat).
 */

/**
 * billingData.country arrives as an English name ("Saudi Arabia") or
 * a 2-letter code ("SA") depending on the client path. Ad platforms
 * want ISO 3166-1 alpha-2 — resolve names before hashing / sending.
 */
export function resolveCountryISO(
  country: string | null | undefined,
): string | null {
  if (!country) return null;
  return countryNameToCode(country);
}

/** SHA-256 hash of a trimmed, lowercased value. */
export function sha256(value: string): string {
  return crypto
    .createHash('sha256')
    .update(value.trim().toLowerCase())
    .digest('hex');
}

/**
 * ISO codes / common names → international dialing code.
 * Covers the markets these stores sell to; extend as needed.
 */
const DIAL_CODES: Record<string, string> = {
  sa: '966', sau: '966', 'saudi arabia': '966', ksa: '966',
  eg: '20', egy: '20', egypt: '20',
  ae: '971', are: '971', uae: '971', 'united arab emirates': '971',
  kw: '965', kwt: '965', kuwait: '965',
  bh: '973', bhr: '973', bahrain: '973',
  qa: '974', qat: '974', qatar: '974',
  om: '968', omn: '968', oman: '968',
  jo: '962', jor: '962', jordan: '962',
  lb: '961', lbn: '961', lebanon: '961',
  iq: '964', irq: '964', iraq: '964',
  tr: '90', tur: '90', turkey: '90',
  gb: '44', gbr: '44', uk: '44', 'united kingdom': '44',
  us: '1', usa: '1', 'united states': '1',
};

function dialCodeFor(country?: string): string | null {
  if (!country) return null;
  const key = country.trim().toLowerCase();
  if (DIAL_CODES[key]) return DIAL_CODES[key];
  // Fall back to the full name→ISO map, then look up by code.
  const iso = resolveCountryISO(country);
  return iso ? DIAL_CODES[iso.toLowerCase()] || null : null;
}

/**
 * Normalize a phone number to country-code-prefixed digits — the
 * format all four platforms expect before SHA-256 hashing:
 *   - Meta/TikTok: digits with country calling code (no `+`)
 *   - Snapchat:    digits only, `00`/`0` prefixes stripped
 *   - OpenAI:      digits, no `+`, no leading zeros, 8–15 digits
 *
 * `countryHint` (ISO code or country name from billing data) is used
 * to prepend the calling code when the number is in national format
 * (e.g. `05xxxxxxxx` → `9665xxxxxxxx` for Saudi).
 *
 * Returns `null` when the result is too short to be a real number —
 * callers skip the field rather than hash a bad value.
 */
export function normalizePhoneDigits(
  phone: string | undefined | null,
  countryHint?: string,
): string | null {
  if (!phone) return null;
  let digits = phone.replace(/[^\d]/g, '');
  if (!digits) return null;

  // Strip the international `00` prefix — the digits that follow
  // already contain the calling code.
  if (digits.startsWith('00')) {
    digits = digits.slice(2);
    return digits.length >= 8 ? digits : null;
  }

  const dial = dialCodeFor(countryHint);

  // National format: trunk `0` + subscriber number → drop the 0 and
  // prepend the calling code.
  if (digits.startsWith('0')) {
    const national = digits.replace(/^0+/, '');
    if (!national) return null;
    digits = dial ? dial + national : national;
    return digits.length >= 8 ? digits : null;
  }

  // Missing leading 0 but clearly national length (e.g. `5xxxxxxxx`
  // for Saudi) — prepend the calling code when we know the country
  // and the digits don't already start with it.
  if (dial && !digits.startsWith(dial) && digits.length <= 10) {
    digits = dial + digits;
  }

  return digits.length >= 8 ? digits : null;
}
