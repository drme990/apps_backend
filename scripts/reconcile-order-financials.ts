import mongoose from 'mongoose';
import { connectDB } from '../lib/db';
import Order from '../lib/models/Order';
import {
  calculateOrderFinancials,
  getPaymentOrderAmount,
} from '../lib/services/order-financials';

type PaymentDoc = {
  status?: string;
  amount?: number;
  currency?: string;
  orderAmount?: number;
  easykashOrderId?: string;
};

type OrderDoc = mongoose.Document & {
  orderNumber: string;
  status: string;
  currency?: string;
  totalAmount?: number;
  fullAmount?: number;
  paidAmount?: number;
  remainingAmount?: number;
  payments?: PaymentDoc[];
  save: () => Promise<unknown>;
};

async function reconcileOrders() {
  await connectDB();

  const cursor = Order.find({ 'payments.0': { $exists: true } }).cursor();

  let scanned = 0;
  let updated = 0;

  for await (const rawOrder of cursor) {
    const order = rawOrder as unknown as OrderDoc;
    scanned += 1;

    let changed = false;

    for (const payment of order.payments || []) {
      const normalizedOrderAmount = getPaymentOrderAmount(order, payment);
      const currentOrderAmount = Number(payment.orderAmount || 0);

      if (
        normalizedOrderAmount > 0 &&
        Math.abs(currentOrderAmount - normalizedOrderAmount) > 0.0001
      ) {
        payment.orderAmount = normalizedOrderAmount;
        changed = true;
      }
    }

    const { totalPaid, remainingAmount } = calculateOrderFinancials(order);
    const currentPaid = Number(order.paidAmount || 0);
    const currentRemaining = Number(order.remainingAmount || 0);

    if (Math.abs(currentPaid - totalPaid) > 0.0001) {
      order.paidAmount = totalPaid;
      changed = true;
    }

    if (Math.abs(currentRemaining - remainingAmount) > 0.0001) {
      order.remainingAmount = remainingAmount;
      changed = true;
    }

    if (order.status === 'paid' && remainingAmount > 0) {
      order.status = 'partial-paid';
      changed = true;
    }

    if (order.status === 'processing' && totalPaid > 0 && remainingAmount > 0) {
      order.status = 'partial-paid';
      changed = true;
    }

    if (
      (order.status === 'processing' ||
        order.status === 'partial-paid' ||
        order.status === 'pending' ||
        order.status === 'failed') &&
      totalPaid > 0 &&
      remainingAmount <= 0
    ) {
      order.status = 'paid';
      changed = true;
    }

    if (changed) {
      await order.save();
      updated += 1;
    }
  }

  console.log(
    `Reconciliation completed. Scanned: ${scanned}, Updated: ${updated}`,
  );
}

reconcileOrders()
  .catch((error) => {
    console.error('Failed to reconcile orders:', error);
    throw error;
  })
  .finally(async () => {
    await mongoose.connection.close();
  });
