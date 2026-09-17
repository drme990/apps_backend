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
 * Propagate `invoiceUrls` and `payments` from the modified order to every
 * linked order (its parent and all sibling sub-orders), then recompute
 * financials on the whole group so they stay in sync.
 *
 * All linked orders share the same `payments` array and the same
 * `fullAmount` (combined total of every order's items), so they end up
 * with identical `paidAmount`, `remainingAmount`, and `status`.
 *
 * The order passed in (`orderId`) is the one that was just modified — its
 * data is propagated to the linked orders. This ensures that when an
 * invoice is uploaded to the parent, every sub-order receives the update.
 *
 * Call this after any mutation to `invoiceUrls` or `payments` on either
 * the parent or any sub-order.
 */
export async function syncSharedFields(orderId: string): Promise<void> {
    const order = await Order.findById(orderId);
    if (!order) return;

    // Resolve the parent for this order's group: the parentOrderId target
    // for sub-orders, or the order itself for a main order.
    const parent = order.isSubOrder && order.parentOrderId
        ? await Order.findById(order.parentOrderId)
        : (!order.isSubOrder ? order : null);
    if (!parent) return;

    // All sub-orders link to the parent via parentOrderId
    const subOrders = await Order.find({
        parentOrderId: parent._id,
        isSubOrder: true,
    });
    if (subOrders.length === 0 && !order.isSubOrder) return;

    const linkedOrders = [parent, ...subOrders];

    // Propagate the modified order's shared fields to every other order
    for (const linked of linkedOrders) {
        if (String(linked._id) !== String(order._id)) {
            linked.invoiceUrls = order.invoiceUrls;
            linked.payments = order.payments;
        }
    }

    // Combined fullAmount = sum of every linked order's item total
    let combinedTotal = 0;
    for (const linked of linkedOrders) {
        combinedTotal += await computeOrderItemTotal(linked);
    }
    for (const linked of linkedOrders) {
        linked.fullAmount = combinedTotal;
    }

    // Save all (each pre-save hook recalculates paidAmount/remainingAmount)
    for (const linked of linkedOrders) {
        await linked.save();
    }

    // Sync status across all — pre-save hooks set amounts but not status
    for (const linked of linkedOrders) {
        const derived = deriveStatus(
            linked.fullAmount || 0,
            linked.paidAmount || 0,
            linked.remainingAmount || 0,
            linked.status,
        );
        if (linked.status !== derived) {
            linked.status = derived;
            await linked.save();
        }
    }
}
