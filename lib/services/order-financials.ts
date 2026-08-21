type PaymentLite = {
  status?: string;
  amount?: number;
  currency?: string;
  orderAmount?: number;
  easykashOrderId?: string;
};

type InvoiceLite = {
  invoiceStatus?: string;
  value?: number;
};

type OrderLite = {
  currency?: string;
  totalAmount?: number;
  fullAmount?: number;
  payments?: PaymentLite[];
  invoiceUrls?: InvoiceLite[];
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

  // Sum paid payment records (gateway payments + manual payments).
  // Invoice uploads with a paidAmount now create a payment entry in
  // order.payments, so they're counted here.
  const paymentsTotal = (order.payments || []).reduce((sum, payment) => {
    if (payment.status === 'paid') {
      return sum + getPaymentOrderAmount(order, payment);
    }

    return sum;
  }, 0);

  // Legacy fallback: if there are NO payment records but there ARE confirmed
  // invoices, use the confirmed invoice values. This covers old orders
  // created before payment entries were added for manual invoice uploads.
  const hasPaymentRecords = (order.payments || []).length > 0;
  const confirmedInvoicesTotal = !hasPaymentRecords
    ? (order.invoiceUrls || []).reduce((sum, invoice) => {
      if (invoice.invoiceStatus === 'confirmed') {
        return sum + toPositiveNumber(invoice.value);
      }
      return sum;
    }, 0)
    : 0;

  // Cap totalPaid at fullAmount — the user cannot pay more than the order
  // costs. (Invoice `value` may exceed fullAmount due to fees/taxes, but the
  // actual paid amount is capped.)
  const rawTotalPaid = paymentsTotal + confirmedInvoicesTotal;
  const totalPaid = fullAmount > 0 ? Math.min(rawTotalPaid, fullAmount) : rawTotalPaid;

  return {
    fullAmount,
    totalPaid,
    remainingAmount: Math.max(0, fullAmount - totalPaid),
  };
}
