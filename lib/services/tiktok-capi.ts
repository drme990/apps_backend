import crypto from 'crypto';

/**
 * TikTok Events API (server-side) helpers.
 *
 * Sends server-side conversion events to TikTok via the
 * `/open_api/v1.3/event/track/` endpoint. Used for the `CompletePayment`
 * (Purchase) event after the webhook confirms a successful payment.
 *
 * PII (email, phone) is SHA-256 hashed before sending — TikTok requires
 * hashed values and never accepts plaintext PII through the API.
 *
 * Required env vars (validated in `instrumentation.ts`):
 *   TIKTOK_PIXEL_ID      — Pixel code, e.g. "D9HOKRRC77U820ARJC4G"
 *   TIKTOK_ACCESS_TOKEN  — Events API access token
 *
 * Optional:
 *   TIKTOK_TEST_EVENT_CODE — when set, events are routed to the Test Event
 *                            tool in TikTok Events Manager instead of live.
 */

const TIKTOK_API_VERSION = 'v1.3';
const TIKTOK_TRACK_URL = `https://business-api.tiktok.com/open_api/${TIKTOK_API_VERSION}/event/track/`;

export interface TiktokUserData {
  email?: string;
  phone?: string;
  external_id?: string;
  ttclid?: string; // TikTok click ID (from URL/cookie)
  ttp?: string; // TikTok browser ID (from _ttp cookie)
  ip?: string;
  user_agent?: string;
}

export interface TiktokContent {
  content_id: string;
  content_type?: string;
  content_name?: string;
  quantity?: number;
  price?: number;
}

export interface TiktokEvent {
  /** TikTok event name, e.g. "CompletePayment", "ViewContent", "InitiateCheckout". */
  event: string;
  /** Unique event id — MUST match the Pixel-side event_id for deduplication. */
  event_id: string;
  /** Unix timestamp (seconds). Defaults to now. */
  event_time?: number;
  /** Page URL where the conversion happened. */
  url?: string;
  /** Currency ISO 4217, e.g. "SAR", "EGP". */
  currency?: string;
  /** Real paid amount, must be > 0. */
  value?: number;
  contents?: TiktokContent[];
  user_data: TiktokUserData;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** SHA-256 hash, lowercase + trimmed (TikTok's required normalization). */
function sha256(value: string): string {
  return crypto
    .createHash('sha256')
    .update(value.trim().toLowerCase())
    .digest('hex');
}

/** Normalize a phone number to E.164 before hashing. */
function normalizePhone(phone: string): string | null {
  if (!phone) return null;
  const trimmed = phone.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith('+')) {
    const digits = '+' + trimmed.slice(1).replace(/[^\d]/g, '');
    return digits.length > 2 ? digits : null;
  }

  const digitsOnly = trimmed.replace(/[^\d]/g, '');
  if (digitsOnly.length >= 11 && digitsOnly.startsWith('00')) {
    return '+' + digitsOnly.slice(2);
  }

  return null;
}

/** Build the `user` block with hashed PII + transport fields as-is. */
function prepareUserData(raw: TiktokUserData): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  if (raw.email && raw.email.trim()) {
    out.email = sha256(raw.email);
  }
  const phone = normalizePhone(raw.phone || '');
  if (phone) {
    out.phone_number = sha256(phone);
  }
  if (raw.external_id && raw.external_id.trim()) {
    out.external_id = sha256(raw.external_id);
  }
  // Transport / attribution fields — sent as-is (not hashed).
  if (raw.ttclid) out.ttclid = raw.ttclid;
  if (raw.ttp) out.ttp = raw.ttp;
  if (raw.ip) out.ip = raw.ip;
  if (raw.user_agent) out.user_agent = raw.user_agent;

  return out;
}

// ─── Core sender ──────────────────────────────────────────────────────────────

/**
 * Send one or more events to TikTok Events API.
 * Returns `true` on success, `false` on failure (never throws).
 */
export async function sendTiktokEvents(
  events: TiktokEvent[],
): Promise<boolean> {
  const pixelId = process.env.TIKTOK_PIXEL_ID;
  const accessToken = process.env.TIKTOK_ACCESS_TOKEN;

  if (!pixelId || !accessToken) {
    console.warn(
      '[TikTok CAPI] Missing TIKTOK_PIXEL_ID or TIKTOK_ACCESS_TOKEN',
    );
    return false;
  }

  if (!events.length) return false;

  try {
    const data = events.map((evt) => {
      const user = prepareUserData(evt.user_data);

      const entry: Record<string, unknown> = {
        event: evt.event,
        event_time: evt.event_time || Math.floor(Date.now() / 1000),
        event_id: evt.event_id,
        user,
      };

      if (evt.url) {
        entry.page = { url: evt.url };
      }

      const properties: Record<string, unknown> = {};
      if (evt.currency) properties.currency = evt.currency;
      if (typeof evt.value === 'number') properties.value = evt.value;
      if (evt.contents && evt.contents.length) {
        properties.contents = evt.contents;
      }
      if (Object.keys(properties).length > 0) {
        entry.properties = properties;
      }

      return entry;
    });

    const payload: Record<string, unknown> = {
      event_source: 'web',
      event_source_id: pixelId,
      data,
    };

    const testCode = process.env.TIKTOK_TEST_EVENT_CODE;
    if (testCode) {
      payload.test_event_code = testCode;
    }

    const res = await fetch(TIKTOK_TRACK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Access-Token': accessToken,
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      console.error('[TikTok CAPI] HTTP error:', res.status, err);
      return false;
    }

    const result = (await res.json()) as {
      code?: number;
      message?: string;
    };
    if (result.code !== 0) {
      console.error('[TikTok CAPI] API error:', result);
      return false;
    }

    console.log(`[TikTok CAPI] ${events.length} event(s) sent`);
    return true;
  } catch (error) {
    console.error('[TikTok CAPI] Error:', error);
    return false;
  }
}

// ─── Convenience wrapper ──────────────────────────────────────────────────────

export interface TiktokPurchaseOpts {
  productId: string;
  productName: string;
  value: number;
  currency: string;
  numItems: number;
  /** Unique order id — used as event_id for Pixel/CAPI deduplication. */
  orderId: string;
  sourceUrl?: string;
  userData: TiktokUserData;
  /** Optional pre-resolved timestamp (seconds). Defaults to now. */
  eventTime?: number;
}

/**
 * Fire a TikTok `CompletePayment` (Purchase) event from the server.
 *
 * MUST only be called after the webhook confirms the payment is PAID.
 * The `orderId` is used as the `event_id` so TikTok can deduplicate
 * against the same event sent from the browser Pixel.
 */
export async function trackTiktokPurchase(
  opts: TiktokPurchaseOpts,
): Promise<boolean> {
  if (!opts.orderId) return false;
  if (typeof opts.value !== 'number' || opts.value <= 0) return false;

  return sendTiktokEvents([
    {
      event: 'CompletePayment',
      event_id: opts.orderId,
      event_time: opts.eventTime,
      url: opts.sourceUrl,
      currency: opts.currency,
      value: opts.value,
      contents: [
        {
          content_id: opts.productId,
          content_type: 'product',
          content_name: opts.productName,
          quantity: opts.numItems,
          price: opts.value,
        },
      ],
      user_data: opts.userData,
    },
  ]);
}
