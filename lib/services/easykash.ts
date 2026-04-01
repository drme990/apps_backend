import crypto from 'crypto';

const EASYKASH_BASE_URL = 'https://back.easykash.net/api';
const DEFAULT_CASH_EXPIRY_HOURS = 3;

export type EasykashPaymentOptionId = 2 | 3 | 4 | 5 | 6;

export interface EasykashPayRequest {
  amount: number;
  currency: string;
  paymentOptions?: EasykashPaymentOptionId[];
  cashExpiry?: number;
  name: string;
  email: string;
  mobile: string;
  redirectUrl: string;
  customerReference: string;
}

export interface EasykashPayResponse {
  redirectUrl: string;
}

export interface EasykashCallbackPayload {
  ProductCode: string;
  PaymentMethod: string;
  ProductType: string;
  Amount: string | number;
  BuyerEmail: string;
  BuyerMobile: string;
  BuyerName: string;
  Timestamp?: string;
  status: string;
  voucher: string;
  easykashRef: string;
  VoucherData: string;
  customerReference: string | number;
  signatureHash: string;
}

export interface EasykashInquiryResponse {
  PaymentMethod: string;
  Amount: string;
  BuyerName: string;
  BuyerEmail: string;
  BuyerMobile: string;
  status: string;
  voucher: string;
  easykashRef: string;
}

export function getEasykashCashExpiryHours(): number {
  const raw = Number.parseInt(
    process.env.EASYKASH_CASH_EXPIRY_HOURS || `${DEFAULT_CASH_EXPIRY_HOURS}`,
    10,
  );

  if (!Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_CASH_EXPIRY_HOURS;
  }

  return raw;
}

function normalizeEasykashRedirectUrl(url: string): string {
  if (!url) return url;

  try {
    const parsed = new URL(url);
    parsed.pathname = parsed.pathname.replace(/\/+/g, '/');
    return parsed.toString();
  } catch {
    return url.replace('://easykash.net//', '://easykash.net/');
  }
}

export type SyncedOrderStatus =
  | 'pending'
  | 'processing'
  | 'paid'
  | 'failed'
  | 'refunded';

export function mapEasykashStatusToOrderStatus(
  rawStatus?: string | null,
): SyncedOrderStatus {
  const status = (rawStatus || '').trim().toUpperCase();

  if (status === 'PAID' || status === 'SUCCESS') {
    return 'paid';
  }

  if (status === 'FAILED' || status === 'EXPIRED' || status === 'DECLINED') {
    return 'failed';
  }

  if (status === 'PENDING') {
    return 'pending';
  }

  if (status === 'REFUNDED') {
    return 'refunded';
  }

  return 'processing';
}

export async function createPayment(
  params: EasykashPayRequest,
): Promise<EasykashPayResponse> {
  const apiKey = process.env.EASYKASH_API_KEY || '';

  const body = {
    amount: params.amount,
    currency: params.currency.toUpperCase(),
    paymentOptions: params.paymentOptions ?? [1, 2, 4, 5, 6, 31],
    cashExpiry: params.cashExpiry ?? getEasykashCashExpiryHours(),
    name: params.name,
    email: params.email,
    mobile: params.mobile,
    redirectUrl: params.redirectUrl,
    customerReference: params.customerReference,
  };

  const response = await fetch(`${EASYKASH_BASE_URL}/directpayv1/pay`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      authorization: apiKey,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('EasyKash create payment error:', errorText);
    throw new Error(`EasyKash API error: ${response.status} - ${errorText}`);
  }

  const json = (await response.json()) as EasykashPayResponse & {
    error?: string;
  };
  if (json.error) {
    console.error('EasyKash create payment error (200):', json.error);
    throw new Error(`EasyKash: ${json.error}`);
  }

  return {
    ...json,
    redirectUrl: normalizeEasykashRedirectUrl(json.redirectUrl),
  };
}

export function verifyCallbackSignature(
  payload: EasykashCallbackPayload,
): boolean {
  const hmacSecret = process.env.EASYKASH_HMAC_SECRET || '';

  if (!hmacSecret) {
    console.warn('EASYKASH_HMAC_SECRET not set — skipping HMAC verification');
    return true;
  }

  const dataToSign = [
    payload.ProductCode,
    payload.Amount,
    payload.ProductType,
    payload.PaymentMethod,
    payload.status,
    payload.easykashRef,
    payload.customerReference,
  ]
    .map((value) => String(value ?? '').trim())
    .join('');

  const calculatedHash = crypto
    .createHmac('sha512', hmacSecret)
    .update(dataToSign)
    .digest('hex');

  return (
    calculatedHash ===
    String(payload.signatureHash || '')
      .trim()
      .toLowerCase()
  );
}

export async function inquirePayment(
  customerReference: string,
): Promise<EasykashInquiryResponse> {
  const apiKey = process.env.EASYKASH_API_KEY || '';

  const response = await fetch(`${EASYKASH_BASE_URL}/cash-api/inquire`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      authorization: apiKey,
    },
    body: JSON.stringify({ customerReference }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('EasyKash inquiry error:', errorText);
    throw new Error(
      `EasyKash inquiry error: ${response.status} - ${errorText}`,
    );
  }

  return (await response.json()) as EasykashInquiryResponse;
}
