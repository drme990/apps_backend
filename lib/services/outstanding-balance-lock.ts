import Order from '@/lib/models/Order';
import { calculateOrderFinancials } from '@/lib/services/order-financials';
import { normalizeEmail } from '@/lib/services/partial-payment-guard';

type CheckoutSource = 'manasik' | 'ghadaq';

interface OutstandingBalanceCandidate {
  _id?: { toString(): string } | string;
  orderNumber?: string;
  currency?: string;
  source?: CheckoutSource;
  userId?: { toString(): string } | string;
  billingData?: {
    email?: string;
  };
  normalizedEmail?: string;
  status?: string;
  totalAmount?: number;
  paidAmount?: number;
  fullAmount?: number;
  remainingAmount?: number;
  payments?: unknown[];
  createdAt?: Date | string;
}

export interface OutstandingBalanceLockInput {
  source: CheckoutSource;
  userId?: string | null;
  email?: string | null;
}

export interface OutstandingBalanceLockResult {
  hasOutstandingBalance: boolean;
  orderId?: string;
  orderNumber?: string;
  currency?: string;
  remainingAmount?: number;
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

export async function getOutstandingBalanceLock(
  input: OutstandingBalanceLockInput,
): Promise<OutstandingBalanceLockResult> {
  const normalizedUserId = input.userId?.trim() || undefined;
  const normalizedBillingEmail = normalizeEmail(input.email);

  const identityClauses: Array<Record<string, unknown>> = [];

  if (normalizedUserId) {
    identityClauses.push({ userId: normalizedUserId });
  }

  if (normalizedBillingEmail) {
    identityClauses.push({ normalizedEmail: normalizedBillingEmail });
    identityClauses.push({ 'billingData.email': normalizedBillingEmail });
  }

  if (identityClauses.length === 0) {
    return { hasOutstandingBalance: false };
  }

  const candidates = (await Order.find({
    source: input.source,
    status: {
      $nin: ['cancelled', 'refunded', 'failed'],
    },
    $or: identityClauses,
  })
    .select({
      _id: 1,
      orderNumber: 1,
      currency: 1,
      source: 1,
      userId: 1,
      billingData: 1,
      normalizedEmail: 1,
      status: 1,
      totalAmount: 1,
      paidAmount: 1,
      fullAmount: 1,
      remainingAmount: 1,
      payments: 1,
      createdAt: 1,
    })
    .sort({ createdAt: -1 })
    .limit(50)
    .lean()) as OutstandingBalanceCandidate[];

  for (const candidate of candidates) {
    const { totalPaid, remainingAmount } = calculateOrderFinancials(candidate);
    if (totalPaid <= 0 || remainingAmount <= 0) {
      continue;
    }

    return {
      hasOutstandingBalance: true,
      orderId: toIdString(candidate._id),
      orderNumber: candidate.orderNumber,
      currency: candidate.currency,
      remainingAmount,
    };
  }

  return { hasOutstandingBalance: false };
}
