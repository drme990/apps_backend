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
  isPartialPayment?: boolean;
  paymentType?: 'full' | 'half' | 'partial';
  totalAmount?: number;
  paidAmount?: number;
  fullAmount?: number;
  remainingAmount?: number;
  payments?: Array<{
    status?: string;
    amount?: number;
    currency?: string;
    orderAmount?: number;
    easykashOrderId?: string;
  }>;
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

function resolvePaymentType(candidate: OutstandingBalanceCandidate) {
  if (candidate.paymentType) {
    return candidate.paymentType;
  }

  if (!candidate.isPartialPayment) {
    return 'full';
  }

  const fullAmount = Number(candidate.fullAmount ?? 0);
  const paidNowAmount = Number(candidate.totalAmount ?? 0);

  if (fullAmount > 0) {
    const halfAmount = Math.ceil(fullAmount / 2);
    if (Math.abs(paidNowAmount - halfAmount) <= 1) {
      return 'half';
    }
  }

  return 'partial';
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

  const latestOrder = (await Order.findOne({
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
      isPartialPayment: 1,
      paymentType: 1,
      totalAmount: 1,
      paidAmount: 1,
      fullAmount: 1,
      remainingAmount: 1,
      payments: 1,
      createdAt: 1,
    })
    .sort({ createdAt: -1 })
    .lean()) as OutstandingBalanceCandidate | null;

  if (!latestOrder) {
    return { hasOutstandingBalance: false };
  }

  // Block only partial payment orders; half-payment orders are allowed.
  if (resolvePaymentType(latestOrder) !== 'partial') {
    return { hasOutstandingBalance: false };
  }

  const { totalPaid, remainingAmount } = calculateOrderFinancials(latestOrder);
  if (totalPaid <= 0 || remainingAmount <= 0) {
    return { hasOutstandingBalance: false };
  }

  return {
    hasOutstandingBalance: true,
    orderId: toIdString(latestOrder._id),
    orderNumber: latestOrder.orderNumber,
    currency: latestOrder.currency,
    remainingAmount,
  };
}
