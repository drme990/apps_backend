import crypto from 'crypto';
import { normalizePhoneDigits, resolveCountryISO } from './capi-utils';

const FB_API_VERSION = 'v21.0';

export interface FBUserData {
  em?: string;
  ph?: string;
  fn?: string;
  ln?: string;
  ct?: string;
  st?: string;
  zp?: string;
  country?: string;
  client_ip_address?: string;
  client_user_agent?: string;
  fbc?: string;
  fbp?: string;
  external_id?: string;
}

export interface FBCustomData {
  value?: number;
  currency?: string;
  content_ids?: string[];
  content_type?: string;
  content_name?: string;
  content_category?: string;
  contents?: { id: string; quantity: number; item_price?: number }[];
  num_items?: number;
  order_id?: string;
}

export interface FBEventPayload {
  event_name: string;
  event_time?: number;
  event_id?: string;
  event_source_url?: string;
  action_source: 'website';
  user_data: FBUserData;
  custom_data?: FBCustomData;
}

function sha256(value: string): string {
  return crypto
    .createHash('sha256')
    .update(value.trim().toLowerCase())
    .digest('hex');
}

function prepareUserData(raw: FBUserData): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (raw.em) out.em = [sha256(raw.em)];
  const phone = normalizePhoneDigits(raw.ph, raw.country);
  if (phone) out.ph = [sha256(phone)];
  if (raw.fn) out.fn = [sha256(raw.fn)];
  if (raw.ln) out.ln = [sha256(raw.ln)];
  if (raw.ct) out.ct = [sha256(raw.ct)];
  if (raw.st) out.st = [sha256(raw.st)];
  if (raw.zp) out.zp = [sha256(raw.zp)];
  // Meta expects the 2-letter ISO code hashed — billingData.country is
  // a free-form name, so resolve it first.
  const countryIso = resolveCountryISO(raw.country);
  if (countryIso) out.country = [sha256(countryIso)];
  if (raw.external_id) out.external_id = [sha256(raw.external_id)];
  if (raw.client_ip_address) out.client_ip_address = raw.client_ip_address;
  if (raw.client_user_agent) out.client_user_agent = raw.client_user_agent;
  if (raw.fbc) out.fbc = raw.fbc;
  if (raw.fbp) out.fbp = raw.fbp;
  return out;
}

export async function sendFBEvent(event: FBEventPayload): Promise<boolean> {
  const FB_PIXEL_ID = process.env.FB_PIXEL_ID;
  const FB_ACCESS_TOKEN = process.env.API_TOKEN;
  const FB_TEST_EVENT_CODE = process.env.FB_TEST_EVENT_CODE;

  if (!FB_PIXEL_ID || !FB_ACCESS_TOKEN) {
    console.warn(
      '[FB CAPI] Missing FB_PIXEL_ID or API_TOKEN — event not sent',
    );
    return false;
  }

  try {
    const payload: Record<string, unknown> = {
      data: [
        {
          event_name: event.event_name,
          event_time: event.event_time || Math.floor(Date.now() / 1000),
          event_id: event.event_id || crypto.randomUUID(),
          event_source_url: event.event_source_url,
          action_source: event.action_source,
          user_data: prepareUserData(event.user_data),
          ...(event.custom_data ? { custom_data: event.custom_data } : {}),
        },
      ],
    };

    if (FB_TEST_EVENT_CODE) {
      payload.test_event_code = FB_TEST_EVENT_CODE;
    }

    const url = `https://graph.facebook.com/${FB_API_VERSION}/${FB_PIXEL_ID}/events?access_token=${FB_ACCESS_TOKEN}`;

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      console.error('[FB CAPI] Error:', res.status, err);
      return false;
    }

    const result = await res.json();
    console.log(`[FB CAPI] ${event.event_name} sent`, result);
    return true;
  } catch (error) {
    console.error('[FB CAPI] Error:', error);
    return false;
  }
}

export async function trackInitiateCheckout(opts: {
  productId: string;
  productName: string;
  value: number;
  currency: string;
  numItems: number;
  sourceUrl?: string;
  userData: FBUserData;
  eventId?: string;
}) {
  return sendFBEvent({
    event_name: 'InitiateCheckout',
    event_id: opts.eventId,
    event_source_url: opts.sourceUrl,
    action_source: 'website',
    user_data: opts.userData,
    custom_data: {
      content_ids: [opts.productId],
      content_type: 'product',
      content_name: opts.productName,
      value: opts.value,
      currency: opts.currency,
      num_items: opts.numItems,
    },
  });
}

export async function trackPurchase(opts: {
  productId: string;
  productName: string;
  value: number;
  currency: string;
  numItems: number;
  /** All order items — aggregated into content_ids/contents/num_items. */
  items?: { productId: string; productName: string; quantity: number; price?: number }[];
  orderId?: string;
  sourceUrl?: string;
  userData: FBUserData;
  eventId?: string;
}) {
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

  return sendFBEvent({
    event_name: 'Purchase',
    event_id: opts.eventId ?? opts.orderId,
    event_source_url: opts.sourceUrl,
    action_source: 'website',
    user_data: opts.userData,
    custom_data: {
      content_ids: items.map((i) => i.productId).filter(Boolean),
      content_type: 'product',
      content_name: items.map((i) => i.productName).filter(Boolean).join(', '),
      contents: items.map((i) => ({
        id: i.productId,
        quantity: i.quantity,
        item_price: i.price,
      })),
      value: opts.value,
      currency: opts.currency,
      num_items: items.reduce((sum, i) => sum + (i.quantity || 1), 0),
      order_id: opts.orderId,
    },
  });
}
