import crypto from 'crypto';

/**
 * OpenAI Events API (server-side) helpers.
 *
 * Sends server-side conversion events to OpenAI via the
 * `https://bzr.openai.com/v1/events` endpoint. Used for the
 * `order_created` (Purchase) event after the webhook confirms a
 * successful payment.
 *
 * PII (email, phone) is SHA-256 hashed before sending.
 *
 * Required env vars:
 *   OPENAI_PIXEL_ID     — Pixel ID, e.g. "5USbAMW2xLCn8yWds3E4kE"
 *   OPENAI_ACCESS_TOKEN — Events API access token
 *
 * Optional:
 *   OPENAI_TEST_EVENT_CODE — when set, events are routed to test mode.
 */

const OPENAI_EVENTS_URL = 'https://bzr.openai.com/v1/events';

export interface OpenAIUserData {
  email?: string;
  phone?: string;
  external_id?: string;
  client_ip_address?: string;
  client_user_agent?: string;
}

export interface OpenAICustomData {
  type?: string;
  value?: number;
  currency?: string;
  order_id?: string;
  content_ids?: string[];
  content_name?: string;
  num_items?: number;
}

export interface OpenAIEventPayload {
  event_name: string;
  event_time?: number;
  event_id?: string;
  event_source_url?: string;
  action_source: 'web';
  user_data: OpenAIUserData;
  custom_data?: OpenAICustomData;
}

function sha256(value: string): string {
  return crypto
    .createHash('sha256')
    .update(value.trim().toLowerCase())
    .digest('hex');
}

function prepareUserData(
  raw: OpenAIUserData,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (raw.email) out.email = sha256(raw.email);
  if (raw.phone) out.phone = sha256(raw.phone.replace(/[^0-9]/g, ''));
  if (raw.external_id) out.external_id = sha256(raw.external_id);
  if (raw.client_ip_address) out.client_ip_address = raw.client_ip_address;
  if (raw.client_user_agent) out.client_user_agent = raw.client_user_agent;
  return out;
}

export async function sendOpenAIEvent(
  event: OpenAIEventPayload,
): Promise<boolean> {
  const pixelId = process.env.OPENAI_PIXEL_ID || '5USbAMW2xLCn8yWds3E4kE';
  const accessToken = process.env.OPENAI_ACCESS_TOKEN;
  const testEventCode = process.env.OPENAI_TEST_EVENT_CODE;

  if (!accessToken) {
    console.warn(
      '[OpenAI CAPI] No access token configured (OPENAI_ACCESS_TOKEN)',
    );
    return false;
  }

  try {
    const events: Record<string, unknown> = {
      id: event.event_id || crypto.randomUUID(),
      type: event.event_name,
      timestamp_ms: event.event_time
        ? event.event_time * 1000
        : Date.now(),
      source_url: event.event_source_url,
      action_source: event.action_source,
      data: {
        ...prepareUserData(event.user_data),
        ...(event.custom_data ?? {}),
      },
    };

    const payload: Record<string, unknown> = {
      validate_only: false,
      events: [events],
    };

    if (testEventCode) {
      (payload as Record<string, unknown>).test_event_code = testEventCode;
    }

    const url = `${OPENAI_EVENTS_URL}?pid=${pixelId}`;
    const res = await fetch(url, {
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

export async function trackOpenAIPurchase(opts: {
  productId?: string;
  productName?: string;
  value: number;
  currency: string;
  numItems?: number;
  orderId?: string;
  sourceUrl?: string;
  userData: OpenAIUserData;
  eventId?: string;
}): Promise<boolean> {
  return sendOpenAIEvent({
    event_name: 'order_created',
    event_id: opts.eventId ?? opts.orderId,
    event_source_url: opts.sourceUrl,
    action_source: 'web',
    user_data: opts.userData,
    custom_data: {
      type: 'contents',
      value: opts.value,
      currency: opts.currency,
      order_id: opts.orderId,
      content_ids: opts.productId ? [opts.productId] : undefined,
      content_name: opts.productName,
      num_items: opts.numItems,
    },
  });
}
