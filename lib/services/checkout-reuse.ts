import { createHash, randomBytes } from 'crypto';
import mongoose from 'mongoose';
import Order, {
  type IOrder,
  type IPayment,
  type IReservationAnswer,
  type PaymentMethod,
} from '@/lib/models/Order';
import {
  createPayment,
  getEasykashCashExpiryHours,
} from '@/lib/services/easykash';
import { convertCurrency } from '@/lib/services/currency';
import { PAYMENT_GATEWAY_CURRENCIES } from '@/lib/services/price-resolver';

/**
 * Checkout order reuse — see enhance-order-createing.md.
 *
 * One customer + one basket = one live unpaid order. Retries either
 * return the existing payment link (`reused`), append a new `-Pn`
 * payment entry to the same order (`revived`), or rewrite the order in
 * place (`updated`). Changing ANY part of the product (items, size,
 * quantity, add-ons, recommended product) mints a brand-new order with
 * a new order number — the previous order and its payment timeline are
 * never touched.
 *
 * `openCheckoutKey` = `${checkoutIdentity}:${basketFingerprint}` exists
 * only on open unpaid orders and carries a unique partial index — the
 * DB itself prevents two open orders per customer+basket.
 */

export const OPEN_CHECKOUT_STATUSES = ['pending', 'processing', 'failed'];

/** How long an unpaid order stays reusable/updatable (72h). */
export const CHECKOUT_REUSE_WINDOW_MS = 72 * 60 * 60 * 1000;

export type CheckoutAction = 'created' | 'reused' | 'revived' | 'updated';

// ─── Hashing helpers ─────────────────────────────────────────────────

function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * Content hash for a reservation picture value. Data URLs hash the
 * decoded image BYTES (the same photo always produces the same hash,
 * unlike the R2 URL which is minted fresh per upload). HTTP URLs hash
 * the URL string itself.
 */
function pictureValueHash(imageValue: string): string {
  if (imageValue.startsWith('data:image/')) {
    const base64Data = imageValue.split(',')[1] || '';
    return sha256Hex(Buffer.from(base64Data, 'base64'));
  }
  return sha256Hex(`url:${imageValue}`);
}

/** Parse a picture field value (JSON array or legacy single string). */
export function parsePictureValues(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed.filter(
        (v): v is string => typeof v === 'string' && v.length > 0,
      );
    }
  } catch {
    // Legacy single-image string
  }
  return typeof value === 'string' && value.length > 0 ? [value] : [];
}

// ─── Identity + fingerprint ──────────────────────────────────────────

/**
 * Customer-scoped key for the reuse lookup. userId wins (every checkout
 * creates/resolves an account); email/phone keep guest-ish and
 * cross-session retries matching.
 */
export function buildCheckoutIdentity(opts: {
  source: string;
  userId: string;
  email: string;
  phone: string;
}): string {
  return sha256Hex(
    [opts.source, opts.userId, opts.email, opts.phone].join('|'),
  );
}

export type CheckoutFingerprintItem = {
  productId: string;
  sizeIndex: number;
  quantity: number;
  isAddOn?: boolean;
};

function canonicalItems(items: CheckoutFingerprintItem[]): string[] {
  return items
    .map(
      (i) =>
        `${i.productId}:${i.sizeIndex ?? 0}:${i.quantity ?? 1}:${i.isAddOn ? 'a' : ''}`,
    )
    .sort();
}

/**
 * sha256 over the ORDERED PRODUCT ONLY — items (main product + size +
 * quantity + recommended product + add-ons) plus the upgrade origin
 * (an upgrade of a previous product is a different order than a fresh
 * purchase of the same basket). Any change to the product part yields
 * a different hash, and since this hash is part of the openCheckoutKey,
 * the changed checkout can never match — or mutate — the previous
 * order. It always creates a new order number.
 */
export function buildCheckoutBasketFingerprint(
  items: CheckoutFingerprintItem[],
  upgradeFromProductId?: string,
): string {
  return sha256Hex(
    JSON.stringify({
      items: canonicalItems(items),
      upgrade: upgradeFromProductId || '',
    }),
  );
}

/** The unique "open checkout slot" — one per customer + exact basket. */
export function buildOpenCheckoutKey(
  checkoutIdentity: string,
  basketFingerprint: string,
): string {
  return `${checkoutIdentity}:${basketFingerprint}`;
}

/**
 * sha256 over the canonical checkout inputs. Canonicalization sorts
 * items and reservation fields so field order never forks the hash.
 * Picture answers contribute their file-byte hashes, not URLs.
 */
export function buildCheckoutFingerprint(opts: {
  source: string;
  userId: string;
  email: string;
  phone: string;
  /** Customer-facing billing name — embedded in the gateway link. */
  fullName: string;
  /** Billing country — shown on the order and gateway metadata. */
  country: string;
  items: CheckoutFingerprintItem[];
  reservationAnswers: IReservationAnswer[];
  paymentType: string;
  fullAmount: number;
  /** The actual charge amount (custom partial amounts differ here). */
  payAmount: number;
  currency: string;
  couponCode?: string;
}): string {
  const canonicalItemList = canonicalItems(opts.items);

  const canonicalReservation = opts.reservationAnswers
    .map((answer) => {
      if (answer.type === 'picture') {
        const hashes = parsePictureValues(answer.value)
          .map(pictureValueHash)
          .sort();
        return `${answer.key}=img:${hashes.join(',')}`;
      }
      return `${answer.key}=${(answer.value || '').trim()}`;
    })
    .sort();

  const payload = {
    source: opts.source,
    userId: opts.userId,
    email: opts.email,
    phone: opts.phone,
    fullName: opts.fullName.trim(),
    country: opts.country,
    items: canonicalItemList,
    reservation: canonicalReservation,
    paymentType: opts.paymentType,
    fullAmount: opts.fullAmount,
    payAmount: opts.payAmount,
    currency: opts.currency,
    coupon: opts.couponCode || '',
  };

  return sha256Hex(JSON.stringify(payload));
}

// ─── Candidate lookup ────────────────────────────────────────────────

/**
 * Release a stale openCheckoutKey slot (order too old to reuse, or a
 * key orphaned by a writer that bypassed the hooks). Lets the next
 * create claim the slot.
 */
export async function releaseStaleOpenKey(
  orderId: mongoose.Types.ObjectId | string,
): Promise<void> {
  await Order.updateOne(
    { _id: String(orderId) },
    { $unset: { openCheckoutKey: '' } },
  );
}

// ─── Payment timeline helpers ────────────────────────────────────────

/**
 * The live pending payment, if one exists: status pending, has a
 * redirect URL, and not past expiresAt (plus the cash-expiry window
 * from creation, matching the old reuse check).
 */
export function findLivePendingPayment(order: IOrder): IPayment | null {
  const now = Date.now();
  const cashWindowMs = getEasykashCashExpiryHours() * 60 * 60 * 1000;
  const payments = order.payments ?? [];

  const pending = payments
    .filter(
      (p) => p.status === 'pending' && p.redirectUrl && p.expiresAt,
    )
    .sort(
      (a, b) =>
        new Date(b.createdAt || 0).getTime() -
        new Date(a.createdAt || 0).getTime(),
    );

  for (const p of pending) {
    const expiresAt = new Date(p.expiresAt as Date).getTime();
    const createdAt = p.createdAt ? new Date(p.createdAt).getTime() : 0;
    if (
      expiresAt > now &&
      (createdAt === 0 || createdAt + cashWindowMs > now)
    ) {
      return p;
    }
  }
  return null;
}

/** Mark every pending payment entry expired (stale-link safety). */
export function expirePendingPayments(order: IOrder): number {
  let expired = 0;
  for (const payment of order.payments ?? []) {
    if (payment.status === 'pending') {
      payment.status = 'expired';
      expired += 1;
    }
  }
  return expired;
}

/** Next `-Pn` attempt number from the payment timeline. */
export function nextPaymentAttemptNumber(order: {
  orderNumber: string;
  payments?: IPayment[];
}): number {
  const prefix = `${order.orderNumber}-P`;
  const attempts = (order.payments ?? [])
    .map((payment) => {
      const value = payment.easykashOrderId || '';
      if (!value.startsWith(prefix)) return 0;
      const parsed = Number.parseInt(value.slice(prefix.length), 10);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
    })
    .filter((n) => n > 0);
  return attempts.length ? Math.max(...attempts) + 1 : 1;
}

function generatePaymentId(): string {
  return `pay_${randomBytes(12).toString('hex')}`;
}

function isCustomerReferenceAlreadyUsedError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes('customerreference') &&
    (message.includes('already used') || message.includes('already exists'))
  );
}

export interface AttachPaymentResult {
  payment: IPayment;
  redirectUrl: string;
  /** EasyKash-side amount/currency actually charged. */
  gatewayAmount: number;
  gatewayCurrency: string;
}

export class GatewayPaymentError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'not_configured'
      | 'conversion_failed'
      | 'amount_too_low'
      | 'gateway_error',
  ) {
    super(message);
    this.name = 'GatewayPaymentError';
  }
}

/**
 * Create an EasyKash payment and append it to the order's payment
 * timeline as the next `-Pn` entry. Shared by checkout create, revive,
 * and update-in-place so all paths produce identical payment records.
 *
 * Throws GatewayPaymentError — callers decide whether to mark the order
 * failed or surface the error.
 */
export async function attachEasykashPayment(opts: {
  order: IOrder & { orderNumber: string };
  /** Amount in ORDER currency (payAmount — partial for partial orders). */
  orderAmount: number;
  orderCurrency: string;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  ip?: string;
  userId?: string;
}): Promise<AttachPaymentResult> {
  const { order } = opts;

  if (!process.env.EASYKASH_API_KEY) {
    throw new GatewayPaymentError(
      'Payment gateway not configured',
      'not_configured',
    );
  }

  // Convert to a gateway-supported currency (EGP) when needed.
  let gatewayAmount = opts.orderAmount;
  let gatewayCurrency = opts.orderCurrency.toUpperCase();

  if (
    !PAYMENT_GATEWAY_CURRENCIES.includes(
      gatewayCurrency as (typeof PAYMENT_GATEWAY_CURRENCIES)[number],
    )
  ) {
    const converted = await convertCurrency(
      opts.orderAmount,
      gatewayCurrency,
      'EGP',
    );
    if (!Number.isFinite(converted) || converted <= 0) {
      throw new GatewayPaymentError(
        `Unable to convert ${gatewayCurrency} amount to EGP`,
        'conversion_failed',
      );
    }
    gatewayAmount = Math.ceil(converted);
    gatewayCurrency = 'EGP';
  }

  if (gatewayAmount <= 1) {
    throw new GatewayPaymentError(
      `Payment amount is too low. Minimum accepted by the payment gateway is 2 ${gatewayCurrency}.`,
      'amount_too_low',
    );
  }

  const sourceBaseUrls: Record<string, string> = {
    manasik: process.env.MANASIK_URL || 'https://www.manasik.net',
    ghadaq: process.env.GHADAQ_URL || 'https://www.ghadaqplus.com',
  };
  const baseUrl =
    sourceBaseUrls[order.source || 'manasik'] || sourceBaseUrls.manasik;

  const cashExpiryHours = getEasykashCashExpiryHours();
  const existingReferences = new Set(
    (order.payments ?? []).map((p) => p.easykashOrderId),
  );
  let attemptNum = nextPaymentAttemptNumber(order);

  let redirectUrl: string | null = null;
  let easykashOrderId: string | null = null;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    let candidateReference = `${order.orderNumber}-P${attemptNum}`;
    while (existingReferences.has(candidateReference)) {
      attemptNum += 1;
      candidateReference = `${order.orderNumber}-P${attemptNum}`;
    }

    try {
      const response = await createPayment({
        amount: gatewayAmount,
        currency: gatewayCurrency,
        name: opts.customerName,
        email: opts.customerEmail,
        mobile: opts.customerPhone,
        cashExpiry: cashExpiryHours,
        redirectUrl: `${baseUrl}/payment/status?orderNumber=${order.orderNumber}`,
        customerReference: candidateReference,
      });
      redirectUrl = response.redirectUrl;
      easykashOrderId = candidateReference;
      break;
    } catch (gatewayError) {
      if (isCustomerReferenceAlreadyUsedError(gatewayError)) {
        existingReferences.add(candidateReference);
        attemptNum += 1;
        continue;
      }
      throw gatewayError instanceof Error
        ? new GatewayPaymentError(gatewayError.message, 'gateway_error')
        : gatewayError;
    }
  }

  if (!redirectUrl || !easykashOrderId) {
    throw new GatewayPaymentError(
      'Unable to allocate a unique EasyKash customerReference',
      'gateway_error',
    );
  }

  const payment: IPayment = {
    paymentId: generatePaymentId(),
    easykashOrderId,
    orderAmount: opts.orderAmount,
    gatewayAmount,
    gatewayCurrency,
    amount: opts.orderAmount,
    currency: opts.orderCurrency.toUpperCase(),
    status: 'pending',
    paymentMethod: 'easykash' as PaymentMethod,
    redirectUrl,
    expiresAt: new Date(Date.now() + cashExpiryHours * 60 * 60 * 1000),
    createdAt: new Date(),
  };

  if (!order.payments) order.payments = [];
  order.payments.push(payment);

  if (!order.paymentAttempts) order.paymentAttempts = [];
  order.paymentAttempts.push({
    createdAt: new Date(),
    ip: opts.ip || undefined,
    userId: opts.userId || undefined,
  });

  return { payment, redirectUrl, gatewayAmount, gatewayCurrency };
}
