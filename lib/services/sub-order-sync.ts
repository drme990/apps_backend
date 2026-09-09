import Order from '@/lib/models/Order';
import type { OrderStatus } from '@/lib/models/Order';
import { convertCurrency } from '@/lib/services/currency';

/**
 * Calculate an order's individual total from its items, handling currency
 * conversion. This is the "real" order total regardless of whether the order
 * uses partial payment (where `totalAmount` stores only the paid portion).
 */
async function computeOrderItemTotal(order: {
    items?: Array<{ price?: number; quantity?: number; currency?: string }>;
    currency?: string;
}): Promise<number> {
    const orderCurrency = (order.currency || 'EGP').toUpperCase();
    let total = 0;
    for (const item of order.items || []) {
        const itemCurrency = (item.currency || orderCurrency).toUpperCase();
        const itemSubtotal = (item.price || 0) * (item.quantity || 1);
        if (itemCurrency === orderCurrency) {
            total += itemSubtotal;
        } else {
            try {
                total += await convertCurrency(itemSubtotal, itemCurrency, orderCurrency);
            } catch {
                total += itemSubtotal;
            }
        }
    }
    return Math.round(total * 100) / 100;
}

/**
 * Derive the canonical order status from the paid/remaining amounts.
 *
 * - `paid`        when remainingAmount is 0 and fullAmount > 0
 * - `partial-paid` when 0 < paidAmount < fullAmount
 * - `pending`     when paidAmount is 0
 *
 * Orders that are already `completed`, `cancelled`, `refunded`, or `failed`
 * are left untouched — those are terminal/admin states that should not be
 * auto-reverted by a payment sync.
 *
 * A partially-paid order is NEVER downgraded to `pending` — once a payment
 * has been recorded, the order stays at least `partial-paid` even if the
 * combined fullAmount increased (e.g. due to a sub-order being added).
 */
function deriveStatus(
    fullAmount: number,
    paidAmount: number,
    remainingAmount: number,
    currentStatus: OrderStatus,
): OrderStatus {
    const TERMINAL: OrderStatus[] = ['completed', 'cancelled', 'refunded', 'failed'];
    if (TERMINAL.includes(currentStatus)) return currentStatus;

    if (fullAmount <= 0) return 'paid';
    if (remainingAmount <= 0) return 'paid';
    if (paidAmount > 0) return 'partial-paid';
    // Never downgrade a paid/partial-paid order to pending
    if (currentStatus === 'paid' || currentStatus === 'partial-paid') return 'partial-paid';
    return 'pending';
}

/**
 * Propagate `invoiceUrls` and `payments` from the modified order to its
 * linked counterpart, then recompute financials on both so they stay in sync.
 *
 * Both orders share the same `payments` array and the same `fullAmount`
 * (combined total of both orders), so they end up with identical
 * `paidAmount`, `remainingAmount`, and `status`.
 *
 * The order passed in (`orderId`) is the one that was just modified — its
 * data is propagated to the linked order. This ensures that when an invoice
 * is uploaded to either order, the other one receives the update.
 *
 * Call this after any mutation to `invoiceUrls` or `payments` on either
 * the parent or the sub-order.
 */
export async function syncSharedFields(orderId: string): Promise<void> {
    const order = await Order.findById(orderId);
    if (!order) return;

    if (order.isSubOrder && order.parentOrderId) {
        const parent = await Order.findById(order.parentOrderId);
        if (!parent) return;

        // Propagate the modified sub-order's data to the parent
        parent.invoiceUrls = order.invoiceUrls;
        parent.payments = order.payments;

        // Set combined fullAmount on both — calculated from each order's items
        const parentItemTotal = await computeOrderItemTotal(parent);
        const subItemTotal = await computeOrderItemTotal(order);
        const combinedTotal = parentItemTotal + subItemTotal;
        parent.fullAmount = combinedTotal;
        order.fullAmount = combinedTotal;

        // Save parent first (pre-save hook recalculates paidAmount/remainingAmount)
        await parent.save();
        // Then save sub-order (its pre-save hook recalculates too)
        await order.save();

        // Now sync status on both — the pre-save hook sets amounts but not status
        const parentStatus = deriveStatus(
            parent.fullAmount || 0,
            parent.paidAmount || 0,
            parent.remainingAmount || 0,
            parent.status,
        );
        const subStatus = deriveStatus(
            order.fullAmount || 0,
            order.paidAmount || 0,
            order.remainingAmount || 0,
            order.status,
        );

        if (parent.status !== parentStatus || order.status !== subStatus) {
            parent.status = parentStatus;
            order.status = subStatus;
            await parent.save();
            await order.save();
        }
    } else if (order.hasSubOrder && order.subOrderId) {
        const subOrder = await Order.findById(order.subOrderId);
        if (!subOrder) return;

        // Propagate the modified parent's data to the sub-order
        subOrder.invoiceUrls = order.invoiceUrls;
        subOrder.payments = order.payments;

        // Set combined fullAmount on both — calculated from each order's items
        const parentItemTotal = await computeOrderItemTotal(order);
        const subItemTotal = await computeOrderItemTotal(subOrder);
        const combinedTotal = parentItemTotal + subItemTotal;
        order.fullAmount = combinedTotal;
        subOrder.fullAmount = combinedTotal;

        // Save sub-order first, then parent
        await subOrder.save();
        await order.save();

        // Sync status on both
        const parentStatus = deriveStatus(
            order.fullAmount || 0,
            order.paidAmount || 0,
            order.remainingAmount || 0,
            order.status,
        );
        const subStatus = deriveStatus(
            subOrder.fullAmount || 0,
            subOrder.paidAmount || 0,
            subOrder.remainingAmount || 0,
            subOrder.status,
        );

        if (order.status !== parentStatus || subOrder.status !== subStatus) {
            order.status = parentStatus;
            subOrder.status = subStatus;
            await order.save();
            await subOrder.save();
        }
    }
}
