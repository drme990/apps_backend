import { createHash, randomBytes } from 'node:crypto';
import Order, { type OrderStatus, type PaymentType } from '@/lib/models/Order';
import PartialPaymentGuardLock from '@/lib/models/PartialPaymentGuardLock';

type CheckoutSource = 'manasik' | 'ghadaq';
type IdentifierKind = 'userId' | 'email' | 'phone' | 'ip' | 'fingerprint';

const DEFAULT_LOCK_TTL_MS = 20_000;

export const BLOCKING_PARTIAL_PAYMENT_STATUSES: ReadonlyArray<OrderStatus> = [
  'pending',
  'processing',
  'partially-paid',
];

export const ALLOWED_PARTIAL_PAYMENT_STATUSES: ReadonlyArray<OrderStatus> = [
  'paid',
  'completed',
  'failed',
  'refunded',
  'cancelled',
];

export interface CanUserCreatePartialPaymentInput {
  source: CheckoutSource;
  userId?: string | null;
  email?: string | null;
  phone?: string | null;
  ip?: string | null;
  fingerprint?: string | null;
}

export interface NormalizedPartialPaymentIdentity {
  normalizedUserId?: string;
  normalizedEmail?: string;
  normalizedPhone?: string;
  normalizedIp?: string;
  normalizedFingerprint?: string;
  lockKeys: string[];
}

export type PartialPaymentGuardReasonCode =
  | 'ACTIVE_PARTIAL_ORDER'
  | 'INSUFFICIENT_IDENTITY';

export interface CanUserCreatePartialPaymentResult {
  allowed: boolean;
  reasonCode?: PartialPaymentGuardReasonCode;
  message?: string;
  blockingOrderId?: string;
  blockingOrderNumber?: string;
  blockingStatus?: OrderStatus;
  matchedBy?: IdentifierKind[];
}

export interface PartialPaymentCreationLock {
  acquired: boolean;
  retryAfterMs: number;
  release: () => Promise<void>;
}

interface GuardOrderProjection {
  _id?: { toString(): string };
  orderNumber?: string;
  status: OrderStatus;
  userId?: { toString(): string } | string;
  billingData?: {
    email?: string;
    phone?: string;
  };
  normalizedEmail?: string;
  normalizedPhone?: string;
  latestClientIp?: string;
  deviceFingerprint?: string;
  paymentType?: PaymentType;
  isPartialPayment?: boolean;
  totalAmount?: number;
  fullAmount?: number;
  paymentAttempts?: Array<{ ip?: string }>;
}

function toIdString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const normalized = value.trim();
    return normalized || undefined;
  }

  if (
    typeof value === 'object' &&
    value !== null &&
    'toString' in value &&
    typeof value.toString === 'function'
  ) {
    const normalized = value.toString().trim();
    return normalized || undefined;
  }

  return undefined;
}

export function normalizeEmail(
  value: string | null | undefined,
): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : undefined;
}

export function normalizePhone(
  value: string | null | undefined,
): string | undefined {
  if (typeof value !== 'string') return undefined;

  let normalized = value.trim();
  if (!normalized) return undefined;

  normalized = normalized.replace(/[\s().-]/g, '');
  if (normalized.startsWith('00')) {
    normalized = `+${normalized.slice(2)}`;
  }

  if (normalized.startsWith('+')) {
    const digits = normalized.slice(1).replace(/\D/g, '');
    return digits ? `+${digits}` : undefined;
  }

  const digitsOnly = normalized.replace(/\D/g, '');
  return digitsOnly || undefined;
}

export function normalizeIp(
  value: string | null | undefined,
): string | undefined {
  if (typeof value !== 'string') return undefined;

  let normalized = value.trim().toLowerCase();
  if (!normalized || normalized === 'unknown') return undefined;

  if (normalized === '::1') return '127.0.0.1';
  if (normalized.startsWith('::ffff:')) {
    normalized = normalized.slice('::ffff:'.length);
  }

  return normalized || undefined;
}

export function normalizeFingerprint(
  value: string | null | undefined,
): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : undefined;
}

function hashIdentifier(
  source: CheckoutSource,
  kind: IdentifierKind,
  value: string,
) {
  return createHash('sha256')
    .update(`${source}:${kind}:${value}`)
    .digest('hex');
}

function buildLockKey(
  source: CheckoutSource,
  kind: IdentifierKind,
  value: string,
) {
  return `partial:${source}:${kind}:${hashIdentifier(source, kind, value)}`;
}

function buildPhoneRegex(normalizedPhone: string): RegExp | undefined {
  const digitsOnly = normalizedPhone.replace(/\D/g, '');
  if (!digitsOnly) return undefined;

  const escapedDigits = digitsOnly
    .split('')
    .map((digit) => digit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('\\D*');

  return new RegExp(`\\+?${escapedDigits}$`);
}

export function buildPartialPaymentIdentity(
  input: CanUserCreatePartialPaymentInput,
): NormalizedPartialPaymentIdentity {
  const normalizedUserId = toIdString(input.userId);
  const normalizedEmail = normalizeEmail(input.email);
  const normalizedPhone = normalizePhone(input.phone);
  const normalizedIp = normalizeIp(input.ip);
  const normalizedFingerprint = normalizeFingerprint(input.fingerprint);

  const lockKeys = [
    normalizedUserId
      ? buildLockKey(input.source, 'userId', normalizedUserId)
      : null,
    normalizedEmail
      ? buildLockKey(input.source, 'email', normalizedEmail)
      : null,
    normalizedPhone
      ? buildLockKey(input.source, 'phone', normalizedPhone)
      : null,
    normalizedIp ? buildLockKey(input.source, 'ip', normalizedIp) : null,
    normalizedFingerprint
      ? buildLockKey(input.source, 'fingerprint', normalizedFingerprint)
      : null,
  ].filter((key): key is string => !!key);

  return {
    normalizedUserId,
    normalizedEmail,
    normalizedPhone,
    normalizedIp,
    normalizedFingerprint,
    lockKeys: Array.from(new Set(lockKeys)),
  };
}

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: number }).code === 11000
  );
}

async function releaseLockKeys(
  keys: string[],
  ownerToken: string,
): Promise<void> {
  if (keys.length === 0) return;

  await PartialPaymentGuardLock.deleteMany({
    key: { $in: keys },
    ownerToken,
  });
}

export async function acquirePartialPaymentCreationLock(
  input: CanUserCreatePartialPaymentInput,
  options?: { ttlMs?: number },
): Promise<PartialPaymentCreationLock> {
  const identity = buildPartialPaymentIdentity(input);

  if (identity.lockKeys.length === 0) {
    return {
      acquired: true,
      retryAfterMs: 0,
      release: async () => {},
    };
  }

  const ownerToken = randomBytes(12).toString('hex');
  const ttlMs = Math.max(5_000, options?.ttlMs ?? DEFAULT_LOCK_TTL_MS);
  const acquiredKeys: string[] = [];

  for (const key of identity.lockKeys) {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMs);

    try {
      await PartialPaymentGuardLock.findOneAndUpdate(
        {
          key,
          $or: [{ expiresAt: { $lte: now } }, { ownerToken }],
        },
        {
          $set: {
            source: input.source,
            ownerToken,
            expiresAt,
          },
          $setOnInsert: { key },
        },
        { upsert: true, new: true },
      );
      acquiredKeys.push(key);
    } catch (error) {
      await releaseLockKeys(acquiredKeys, ownerToken);

      if (isDuplicateKeyError(error)) {
        return {
          acquired: false,
          retryAfterMs: ttlMs,
          release: async () => {},
        };
      }

      throw error;
    }
  }

  let released = false;

  return {
    acquired: true,
    retryAfterMs: ttlMs,
    release: async () => {
      if (released) return;
      released = true;
      await releaseLockKeys(acquiredKeys, ownerToken);
    },
  };
}

function inferPaymentType(order: {
  paymentType?: PaymentType;
  isPartialPayment?: boolean;
  fullAmount?: number;
  totalAmount?: number;
}): PaymentType {
  if (order.paymentType) return order.paymentType;
  if (!order.isPartialPayment) return 'full';

  const fullAmount = Number(order.fullAmount ?? 0);
  const paidNowAmount = Number(order.totalAmount ?? 0);

  if (fullAmount > 0) {
    const halfAmount = Math.ceil(fullAmount / 2);
    if (Math.abs(paidNowAmount - halfAmount) <= 1) {
      return 'half';
    }
  }

  return 'partial';
}

function resolveMatchedBy(
  order: GuardOrderProjection,
  identity: NormalizedPartialPaymentIdentity,
): IdentifierKind[] {
  const matchedBy: IdentifierKind[] = [];

  const orderUserId = toIdString(order.userId);
  if (identity.normalizedUserId && orderUserId === identity.normalizedUserId) {
    matchedBy.push('userId');
  }

  const orderEmail =
    normalizeEmail(order.normalizedEmail) ||
    normalizeEmail(order.billingData?.email) ||
    undefined;
  if (identity.normalizedEmail && orderEmail === identity.normalizedEmail) {
    matchedBy.push('email');
  }

  const orderPhone =
    normalizePhone(order.normalizedPhone) ||
    normalizePhone(order.billingData?.phone) ||
    undefined;
  if (identity.normalizedPhone && orderPhone === identity.normalizedPhone) {
    matchedBy.push('phone');
  }

  if (identity.normalizedIp) {
    const directOrderIp = normalizeIp(order.latestClientIp);
    const attemptIps = (order.paymentAttempts || [])
      .map((attempt) => normalizeIp(attempt.ip))
      .filter((ip): ip is string => !!ip);

    if (
      directOrderIp === identity.normalizedIp ||
      attemptIps.includes(identity.normalizedIp)
    ) {
      matchedBy.push('ip');
    }
  }

  const orderFingerprint = normalizeFingerprint(order.deviceFingerprint);
  if (
    identity.normalizedFingerprint &&
    orderFingerprint === identity.normalizedFingerprint
  ) {
    matchedBy.push('fingerprint');
  }

  return Array.from(new Set(matchedBy));
}

export async function canUserCreatePartialPayment(
  input: CanUserCreatePartialPaymentInput,
): Promise<CanUserCreatePartialPaymentResult> {
  const identity = buildPartialPaymentIdentity(input);
  const identityClauses: Array<Record<string, unknown>> = [];

  if (identity.normalizedUserId) {
    identityClauses.push({ userId: identity.normalizedUserId });
  }

  if (identity.normalizedEmail) {
    identityClauses.push({ normalizedEmail: identity.normalizedEmail });
    identityClauses.push({ 'billingData.email': identity.normalizedEmail });
  }

  if (identity.normalizedPhone) {
    identityClauses.push({ normalizedPhone: identity.normalizedPhone });

    const phoneRegex = buildPhoneRegex(identity.normalizedPhone);
    if (phoneRegex) {
      identityClauses.push({ 'billingData.phone': { $regex: phoneRegex } });
    }
  }

  if (identity.normalizedIp) {
    identityClauses.push({ latestClientIp: identity.normalizedIp });
    identityClauses.push({ 'paymentAttempts.ip': identity.normalizedIp });
  }

  if (identity.normalizedFingerprint) {
    identityClauses.push({ deviceFingerprint: identity.normalizedFingerprint });
  }

  if (identityClauses.length === 0) {
    return {
      allowed: false,
      reasonCode: 'INSUFFICIENT_IDENTITY',
      message:
        'Unable to verify customer identity for partial payment. Please provide valid contact details.',
    };
  }

  const candidates = (await Order.find({
    source: input.source,
    status: { $in: BLOCKING_PARTIAL_PAYMENT_STATUSES },
    isPartialPayment: true,
    $or: identityClauses,
  })
    .select({
      _id: 1,
      orderNumber: 1,
      status: 1,
      userId: 1,
      billingData: 1,
      normalizedEmail: 1,
      normalizedPhone: 1,
      latestClientIp: 1,
      deviceFingerprint: 1,
      paymentType: 1,
      isPartialPayment: 1,
      totalAmount: 1,
      fullAmount: 1,
      paymentAttempts: 1,
      createdAt: 1,
    })
    .sort({ createdAt: -1 })
    .limit(25)
    .lean()) as GuardOrderProjection[];

  for (const candidate of candidates) {
    if (inferPaymentType(candidate) !== 'partial') {
      continue;
    }

    const matchedBy = resolveMatchedBy(candidate, identity);
    if (matchedBy.length === 0) {
      continue;
    }

    return {
      allowed: false,
      reasonCode: 'ACTIVE_PARTIAL_ORDER',
      message:
        'You already have an active partial payment order. Complete it before creating a new one.',
      blockingOrderId: toIdString(candidate._id),
      blockingOrderNumber: candidate.orderNumber,
      blockingStatus: candidate.status,
      matchedBy,
    };
  }

  return { allowed: true };
}
