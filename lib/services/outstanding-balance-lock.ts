import Order from '@/lib/models/Order';
import { calculateOrderFinancials } from '@/lib/services/order-financials';
import { BLOCKING_PARTIAL_PAYMENT_STATUSES } from '@/lib/services/partial-payment-guard';

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
  totalUnpaidOrders?: number; // Total count of unpaid orders
  oldestUnpaidOrderNumber?: string; // For reference
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

function toPositiveNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export async function getOutstandingBalanceLock(
  input: OutstandingBalanceLockInput,
): Promise<OutstandingBalanceLockResult> {
  const normalizedUserId = input.userId?.trim() || undefined;

  const identityClauses: Array<Record<string, unknown>> = [];

  // Only use userId for matching - ignore email/phone
  if (normalizedUserId) {
    identityClauses.push({ userId: normalizedUserId });
  }

  if (identityClauses.length === 0) {
    return { hasOutstandingBalance: false };
  }

  // Find ALL unpaid orders (not just the latest) - sorted by oldest first
  const allUnpaidOrders = (await Order.find({
    source: input.source,
    status: { $in: BLOCKING_PARTIAL_PAYMENT_STATUSES },
    $or: identityClauses,
  })
    .select({
      _id: 1,
      orderNumber: 1,
      currency: 1,
      source: 1,
      userId: 1,
      billingData: 1,
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
    .sort({ createdAt: 1 }) // Oldest first
    .lean()) as OutstandingBalanceCandidate[];

  // Filter to only orders with actual remaining balance
  const ordersWithBalance = allUnpaidOrders.filter((order) => {
    const calculated = calculateOrderFinancials(order);
    let remainingAmount = calculated.remainingAmount;
    let totalPaid = calculated.totalPaid;

    if (remainingAmount <= 0) {
      const explicitRemaining = toPositiveNumber(order.remainingAmount);
      if (explicitRemaining > 0) {
        remainingAmount = explicitRemaining;
      }
    }

    if (totalPaid <= 0) {
      const explicitPaid = toPositiveNumber(order.paidAmount);
      if (explicitPaid > 0) {
        totalPaid = explicitPaid;
      } else if (remainingAmount > 0) {
        const fullAmount =
          toPositiveNumber(order.fullAmount) ||
          toPositiveNumber(order.totalAmount);
        if (fullAmount > 0) {
          totalPaid = Math.max(0, fullAmount - remainingAmount);
        }
      }
    }

    return totalPaid > 0 && remainingAmount > 0;
  });

  if (ordersWithBalance.length === 0) {
    return { hasOutstandingBalance: false };
  }

  // Return the OLDEST unpaid order (first in the array)
  const oldestOrder = ordersWithBalance[0];
  const calculated = calculateOrderFinancials(oldestOrder);
  let remainingAmount = calculated.remainingAmount;

  if (remainingAmount <= 0) {
    const explicitRemaining = toPositiveNumber(oldestOrder.remainingAmount);
    if (explicitRemaining > 0) {
      remainingAmount = explicitRemaining;
    }
  }

  return {
    hasOutstandingBalance: true,
    orderId: toIdString(oldestOrder._id),
    orderNumber: oldestOrder.orderNumber,
    currency: oldestOrder.currency,
    remainingAmount,
    totalUnpaidOrders: ordersWithBalance.length,
    oldestUnpaidOrderNumber: oldestOrder.orderNumber,
  };
}
