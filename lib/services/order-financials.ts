type PaymentLite = {
  status?: string;
  amount?: number;
  currency?: string;
  orderAmount?: number;
  easykashOrderId?: string;
};

type OrderLite = {
  currency?: string;
  totalAmount?: number;
  fullAmount?: number;
  payments?: PaymentLite[];
};

const INITIAL_ATTEMPT_REGEX = /-P\d+$/;

function toPositiveNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function getPaymentOrderAmount(
  order: Pick<OrderLite, 'currency' | 'totalAmount'>,
  payment: PaymentLite,
): number {
  const explicitOrderAmount = toPositiveNumber(payment.orderAmount);
  if (explicitOrderAmount > 0) return explicitOrderAmount;

  const amount = toPositiveNumber(payment.amount);
  if (amount <= 0) return 0;

  const orderCurrency = (order.currency || '').toUpperCase().trim();
  const paymentCurrency = (payment.currency || '').toUpperCase().trim();

  if (orderCurrency && paymentCurrency === orderCurrency) {
    return amount;
  }

  // Backward compatibility for historical checkout records created before
  // orderAmount was stored separately from gateway amount/currency.
  if (INITIAL_ATTEMPT_REGEX.test(payment.easykashOrderId || '')) {
    const initialOrderAmount = toPositiveNumber(order.totalAmount);
    if (initialOrderAmount > 0) return initialOrderAmount;
  }

  return 0;
}

export function calculateOrderFinancials(order: OrderLite) {
  const fullAmount =
    toPositiveNumber(order.fullAmount) || toPositiveNumber(order.totalAmount);

  const totalPaid = (order.payments || []).reduce((sum, payment) => {
    if (payment.status === 'paid') {
      return sum + getPaymentOrderAmount(order, payment);
    }

    return sum;
  }, 0);

  return {
    fullAmount,
    totalPaid,
    remainingAmount: Math.max(0, fullAmount - totalPaid),
  };
}
