import crypto from 'crypto';
import { normalizePhoneDigits, resolveCountryISO } from './capi-utils';

/**
 * OpenAI Events API (server-side) helpers.
 *
 * Sends server-side conversion events to OpenAI via the
 * `https://bzr.openai.com/v1/events` endpoint. Used for the
 * `order_created` (Purchase) event after the webhook confirms a
 * successful payment.
 *
 * Schema follows developers.openai.com/ads/conversions-api:
 *   - events[].id            — dedup id (order number for purchases)
 *   - events[].type          — 'order_created', 'checkout_started', etc.
 *   - events[].timestamp_ms  — Unix ms (within last 7 days)
 *   - events[].source_url    — required for action_source 'web'
 *   - events[].user          — matching fields (*_sha256 arrays, raw ip/ua)
 *   - events[].data          — { type: 'contents', amount (minor units), currency, contents[] }
 *
 * PII (email, phone, external_id) is SHA-256 hashed before sending.
 * There is no test_event_code — use `validate_only: true` for testing.
 *
 * Required env vars:
 *   OPENAI_PIXEL_ID     — Pixel ID, e.g. "5USbAMW2xLCn8yWds3E4kE"
 *   OPENAI_ACCESS_TOKEN — Conversions API key (Bearer)
 */

const OPENAI_EVENTS_URL = 'https://bzr.openai.com/v1/events';

export interface OpenAIUserData {
  email?: string;
  phone?: string;
  external_id?: string;
  first_name?: string;
  last_name?: string;
  country?: string;
  city?: string;
  /** Raw `__obref` first-party cookie value (unhashed). */
  obref?: string;
  client_ip_address?: string;
  client_user_agent?: string;
}

export interface OpenAIContent {
  id?: string;
  name?: string;
  content_type?: string;
  quantity?: number;
  /** Item price in minor units (e.g. 8900 for $89.00). */
  amount?: number;
  currency?: string;
}

export interface OpenAIDataPayload {
  /** Data shape — 'contents' for order_created/checkout_started/etc. */
  type: 'contents' | 'customer_action' | 'plan_enrollment' | 'custom';
  /** Event monetary value in minor units (integer). Requires currency. */
  amount?: number;
  /** ISO 4217, e.g. "SAR". Required when amount is present. */
  currency?: string;
  contents?: OpenAIContent[];
  [key: string]: unknown;
}

export interface OpenAIEventPayload {
  /** Standard event type, e.g. 'order_created'. */
  event_name: string;
  /** Dedup id — reuse across retries and across pixel/CAPI. */
  event_id?: string;
  /** Unix ms. Defaults to now. */
  timestamp_ms?: number;
  /** Required for action_source 'web'. */
  source_url?: string;
  /** Opaque OpenAI-provided attribution id from the ad click (unhashed). */
  oppref?: string;
  action_source: 'web';
  user_data: OpenAIUserData;
  data: OpenAIDataPayload;
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/**
 * Normalize per OpenAI rules then hash.
 *  - email: trim + lowercase
 *  - phone: keep country calling code, strip whitespace/parens/periods/
 *    hyphens, remove leading '+' and leading zeros → 8–15 digits
 *  - external_id: trim only (case preserved)
 *  - names: lowercase, remove whitespace + ASCII punctuation
 */
function hashEmail(email: string): string {
  return sha256(email.trim().toLowerCase());
}

function hashPhone(phone: string, country?: string): string | null {
  const digits = normalizePhoneDigits(phone, country);
  if (!digits || digits.length > 15) return null;
  return sha256(digits);
}

function hashExternalId(id: string): string {
  return sha256(id.trim());
}

function hashName(name: string): string {
  // lowercase, remove whitespace + ASCII punctuation; preserve non-ASCII
  return sha256(
    name
      .toLowerCase()
      .replace(/[\s!-\/:-@[-`{-~]+/g, ''),
  );
}

/** Build the events[].user object with *_sha256 arrays + raw ip/ua. */
function prepareUserData(raw: OpenAIUserData): Record<string, unknown> {
  const user: Record<string, unknown> = {};

  if (raw.email?.trim()) {
    user.emails_sha256 = [hashEmail(raw.email)];
  }
  if (raw.phone?.trim()) {
    const hashed = hashPhone(raw.phone, raw.country);
    if (hashed) user.phone_numbers_sha256 = [hashed];
  }
  if (raw.external_id?.trim()) {
    user.external_ids_sha256 = [hashExternalId(raw.external_id)];
  }
  if (raw.first_name?.trim()) {
    user.first_names_sha256 = [hashName(raw.first_name)];
  }
  if (raw.last_name?.trim()) {
    user.last_names_sha256 = [hashName(raw.last_name)];
  }
  // OpenAI expects raw 2-letter ISO codes — billingData.country is a
  // free-form name, so resolve it first.
  const countryIso = resolveCountryISO(raw.country);
  if (countryIso) user.countries = [countryIso];
  if (raw.city?.trim()) user.cities = [raw.city.trim()];
  if (raw.obref?.trim()) user.obref = raw.obref;
  if (raw.client_ip_address) user.ip_address = raw.client_ip_address;
  if (raw.client_user_agent) user.user_agent = raw.client_user_agent;

  return user;
}

export async function sendOpenAIEvent(
  event: OpenAIEventPayload,
): Promise<boolean> {
  const pixelId = process.env.OPENAI_PIXEL_ID;
  const accessToken = process.env.OPENAI_ACCESS_TOKEN;

  if (!pixelId || !accessToken) {
    console.warn(
      '[OpenAI CAPI] Missing OPENAI_PIXEL_ID or OPENAI_ACCESS_TOKEN',
    );
    return false;
  }

  try {
    const evt: Record<string, unknown> = {
      id: event.event_id || crypto.randomUUID(),
      type: event.event_name,
      timestamp_ms: event.timestamp_ms ?? Date.now(),
      source_url: event.source_url,
      action_source: event.action_source,
      data: event.data,
    };

    if (event.oppref) evt.oppref = event.oppref;

    const user = prepareUserData(event.user_data);
    if (Object.keys(user).length > 0) {
      evt.user = user;
    }

    const payload = {
      validate_only: false,
      events: [evt],
    };

    const res = await fetch(`${OPENAI_EVENTS_URL}?pid=${pixelId}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      console.error('[OpenAI CAPI] Error:', res.status, err);
      return false;
    }

    const result = await res.json();
    console.log(`[OpenAI CAPI] ${event.event_name} sent`, result);
    return true;
  } catch (error) {
    console.error('[OpenAI CAPI] Error:', error);
    return false;
  }
}

/** Convert a major-unit amount (e.g. 89.99) to minor units (8999). */
function toMinorUnits(value: number): number {
  return Math.round(value * 100);
}

export async function trackOpenAIPurchase(opts: {
  productId?: string;
  productName?: string;
  value: number;
  currency: string;
  numItems?: number;
  /** All order items — aggregated into data.contents[]. */
  items?: { productId: string; productName: string; quantity: number; price?: number }[];
  orderId?: string;
  sourceUrl?: string;
  /** OpenAI click attribution id (from ad click), unhashed. */
  oppref?: string;
  userData: OpenAIUserData;
  eventId?: string;
}): Promise<boolean> {
  const items =
    opts.items && opts.items.length
      ? opts.items
      : [
        {
          productId: opts.productId,
          productName: opts.productName,
          quantity: opts.numItems ?? 1,
          price: opts.value,
        },
      ];

  return sendOpenAIEvent({
    event_name: 'order_created',
    event_id: opts.eventId ?? opts.orderId,
    source_url: opts.sourceUrl,
    oppref: opts.oppref,
    action_source: 'web',
    user_data: opts.userData,
    data: {
      type: 'contents',
      amount: toMinorUnits(opts.value),
      currency: opts.currency,
      contents: items.map((i) => ({
        id: i.productId,
        name: i.productName,
        content_type: 'product',
        quantity: i.quantity ?? 1,
        amount: i.price != null ? toMinorUnits(i.price * (i.quantity || 1)) : toMinorUnits(opts.value),
        currency: opts.currency,
      })),
    },
  });
}
