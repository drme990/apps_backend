import crypto from 'crypto';
import { normalizePhoneDigits } from './capi-utils';

/**
 * Snapchat Conversions API (server-side) helpers.
 *
 * Sends server-side conversion events to Snapchat via the
 * `https://tr.snapchat.com/v3/{pixel_id}/events` endpoint.
 *
 * PII (email, phone) is SHA-256 hashed before sending — Snapchat
 * requires hashed values and never accepts plaintext PII through the API.
 *
 * Required env vars:
 *   SNAPCHAT_PIXEL_ID      — Pixel ID (UUID)
 *   SNAPCHAT_ACCESS_TOKEN  — Conversions API access token
 *
 * Optional:
 *   SNAPCHAT_TEST_EVENT_CODE — when set, events are routed to the Test Event
 *                              tool in Snapchat Events Manager instead of live.
 */

export interface SnapUserData {
  em?: string; // email (will be hashed)
  ph?: string; // phone (will be hashed)
  /** Billing country (ISO code or name) — used to normalize phone. */
  country?: string;
  client_ip_address?: string;
  client_user_agent?: string;
  sc_click_id?: string; // Snapchat click ID
  sc_cookie1?: string; // Snapchat cookie value
}

export interface SnapCustomData {
  event_id?: string;
  value?: number | string;
  currency?: string;
  content_ids?: string[];
  content_category?: string[];
  number_items?: string[];
}

export interface SnapEventPayload {
  event_name: string;
  event_time?: number;
  event_id?: string;
  event_source_url?: string;
  action_source: 'website';
  user_data: SnapUserData;
  custom_data?: SnapCustomData;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sha256(value: string): string {
  return crypto
    .createHash('sha256')
    .update(value.trim().toLowerCase())
    .digest('hex');
}

/** Hash PII fields; leave transport fields (IP, UA, sc_click_id, sc_cookie1) as-is. */
function prepareUserData(raw: SnapUserData): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  if (raw.em) out.em = [sha256(raw.em)];
  const phone = normalizePhoneDigits(raw.ph, raw.country);
  if (phone) out.ph = [sha256(phone)];

  // Non-hashed transport fields — note Snap uses `user_agent`
  // (not Meta's `client_user_agent`).
  if (raw.client_ip_address) out.client_ip_address = raw.client_ip_address;
  if (raw.client_user_agent) out.user_agent = raw.client_user_agent;
  if (raw.sc_click_id) out.sc_click_id = raw.sc_click_id;
  if (raw.sc_cookie1) out.sc_cookie1 = raw.sc_cookie1;

  return out;
}

// ─── Core sender ──────────────────────────────────────────────────────────────

/**
 * Send a single event to the Snapchat Conversions API.
 * Returns `true` on success, `false` on failure (never throws).
 */
export async function sendSnapEvent(event: SnapEventPayload): Promise<boolean> {
  const pixelId = process.env.SNAPCHAT_PIXEL_ID;
  const accessToken = process.env.SNAPCHAT_ACCESS_TOKEN;
  const testEventCode = process.env.SNAPCHAT_TEST_EVENT_CODE;

  if (!pixelId || !accessToken) {
    console.warn(
      '[Snapchat CAPI] Missing SNAPCHAT_PIXEL_ID or SNAPCHAT_ACCESS_TOKEN',
    );
    return false;
  }

  try {
    const payload: Record<string, unknown> = {
      data: [
        {
          event_name: event.event_name,
          action_source: event.action_source,
          event_source_url: event.event_source_url,
          event_time: event.event_time || Math.floor(Date.now() / 1000),
          // event_id at both the event level and inside custom_data —
          // Snap's dedup checks the event-level field while their
          // official payload template places it in custom_data.
          event_id: event.event_id,
          user_data: prepareUserData(event.user_data),
          ...(event.custom_data ? { custom_data: event.custom_data } : {}),
        },
      ],
    };

    if (testEventCode) {
      payload.test_event_code = testEventCode;
    }

    const url = `https://tr.snapchat.com/v3/${pixelId}/events?access_token=${accessToken}`;

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      console.error('[Snapchat CAPI] Error:', res.status, err);
      return false;
    }

    const result = await res.json();
    console.log(`[Snapchat CAPI] ${event.event_name} sent`, result);
    return true;
  } catch (error) {
    console.error('[Snapchat CAPI] Error:', error);
    return false;
  }
}

// ─── Convenience wrappers ─────────────────────────────────────────────────────

export async function trackSnapPurchase(opts: {
  productId: string;
  productName: string;
  value: number;
  currency: string;
  numItems: number;
  /** All order items — aggregated into content_ids/number_items. */
  items?: { productId: string; productName: string; quantity: number; price?: number }[];
  orderId?: string;
  sourceUrl?: string;
  userData: SnapUserData;
  eventId?: string;
}): Promise<boolean> {
  if (!opts.orderId) return false;
  if (typeof opts.value !== 'number' || opts.value <= 0) return false;

  const items =
    opts.items && opts.items.length
      ? opts.items
      : [
        {
          productId: opts.productId,
          productName: opts.productName,
          quantity: opts.numItems,
        },
      ];

  return sendSnapEvent({
    event_name: 'PURCHASE',
    event_id: opts.eventId ?? opts.orderId,
    event_source_url: opts.sourceUrl,
    action_source: 'website',
    user_data: opts.userData,
    custom_data: {
      event_id: opts.eventId ?? opts.orderId,
      value: String(opts.value),
      currency: opts.currency,
      content_ids: items.map((i) => i.productId).filter(Boolean),
      content_category: ['product'],
      number_items: items.map((i) => String(i.quantity || 1)),
    },
  });
}

export async function trackSnapPageView(opts: {
  productId?: string;
  category?: string;
  sourceUrl?: string;
  userData: SnapUserData;
  eventId?: string;
}): Promise<boolean> {
  return sendSnapEvent({
    event_name: 'PAGE_VIEW',
    event_id: opts.eventId,
    event_source_url: opts.sourceUrl,
    action_source: 'website',
    user_data: opts.userData,
    custom_data: {
      event_id: opts.eventId,
      content_category: opts.category ? [opts.category] : undefined,
      content_ids: opts.productId ? [opts.productId] : undefined,
    },
  });
}

export async function trackSnapAddToCart(opts: {
  productId: string;
  productName: string;
  value: number;
  currency: string;
  numItems: number;
  sourceUrl?: string;
  userData: SnapUserData;
  eventId?: string;
}): Promise<boolean> {
  return sendSnapEvent({
    event_name: 'ADD_CART',
    event_id: opts.eventId,
    event_source_url: opts.sourceUrl,
    action_source: 'website',
    user_data: opts.userData,
    custom_data: {
      event_id: opts.eventId,
      value: String(opts.value),
      currency: opts.currency,
      content_ids: [opts.productId],
      content_category: ['product'],
      number_items: [String(opts.numItems)],
    },
  });
}
