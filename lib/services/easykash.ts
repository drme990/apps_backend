import crypto from 'crypto';

const EASYKASH_BASE_URL = 'https://back.easykash.net/api';

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
  Amount: string;
  BuyerEmail: string;
  BuyerMobile: string;
  BuyerName: string;
  Timestamp: string;
  status: string;
  voucher: string;
  easykashRef: string;
  VoucherData: string;
  customerReference: string;
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

export async function createPayment(
  params: EasykashPayRequest,
): Promise<EasykashPayResponse> {
  const apiKey = process.env.EASYKASH_API_KEY || '';

  const body = {
    amount: params.amount,
    currency: params.currency.toUpperCase(),
    paymentOptions: params.paymentOptions ?? [1, 2, 4, 5, 6, 31],
    cashExpiry: params.cashExpiry ?? 3,
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

  return json;
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
  ].join('');

  const calculatedHash = crypto
    .createHmac('sha512', hmacSecret)
    .update(dataToSign)
    .digest('hex');

  return calculatedHash === payload.signatureHash;
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
