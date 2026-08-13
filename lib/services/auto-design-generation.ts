/**
 * Automatic design generation service.
 *
 * When an order transitions to a paid state (`paid` or `partial-paid`)
 * from a non-paid state, the backend automatically triggers design
 * generation on the design app — without waiting for an admin to click
 * the "Generate Design" button.
 *
 * Design generation is fire-and-forget: the caller does NOT await it.
 * This is critical because:
 *   1. The payment webhook must return 200 quickly (EasyKash retries
 *      if it doesn't get a fast response).
 *   2. Design generation can take 10-60s per product (canvas render +
 *      R2 upload), and an order may have multiple products.
 *
 * If auto-generation fails (design app down, no template, etc.), the
 * admin can still trigger it manually via the "Generate Design" button
 * in the admin panel — that route is unaffected.
 *
 * Re-generation guard:
 *   We only trigger when the order FIRST enters a paid state. If the
 *   order was already `partial-paid` and transitions to `paid`, we do
 *   NOT regenerate — the design was already created at `partial-paid`.
 *   The admin can always manually regenerate if needed.
 */

import { connectDB } from '@/lib/db';
import Order, { type IOrder, type IOrderDesignUrl } from '@/lib/models/Order';
import Referral from '@/lib/models/Referral';
import {
  generateDesignForProduct,
  type DesignAppResult,
} from '@/lib/services/design-app-callback';

/** Statuses that count as "already paid" — no need to auto-generate. */
const PAID_LIKE_STATUSES = new Set(['paid', 'partial-paid', 'completed']);

/**
 * Check whether a status transition should trigger auto design generation.
 *
 * Returns true only when:
 *   - newStatus is 'paid' or 'partial-paid'
 *   - previousStatus was NOT a paid-like status
 *
 * This means:
 *   pending → partial-paid  ✅ trigger
 *   pending → paid          ✅ trigger
 *   failed → partial-paid   ✅ trigger
 *   partial-paid → paid     ❌ skip (already generated at partial-paid)
 *   paid → paid             ❌ skip (no transition)
 */
export function shouldTriggerAutoDesignGeneration(
  previousStatus: string,
  newStatus: string,
): boolean {
  const entersPaidState =
    newStatus === 'paid' || newStatus === 'partial-paid';
  const wasAlreadyPaid = PAID_LIKE_STATUSES.has(previousStatus);
  return entersPaidState && !wasAlreadyPaid;
}

/**
 * Trigger automatic design generation for an order.
 *
 * This is fire-and-forget — the caller should NOT await it.
 * It runs entirely in the background and logs results/errors to the
 * server logger.
 *
 * The function is idempotent in the sense that if it fails, it simply
 * logs the error — the admin can manually trigger generation later.
 * It does NOT retry on its own (keeping the system simple).
 *
 * @param orderId The MongoDB _id of the order (string or ObjectId)
 */
export async function triggerAutoDesignGeneration(
  orderId: string,
): Promise<void> {
  const logPrefix = `[auto-design-gen order=${orderId}]`;

  try {
    await connectDB();

    const order = (await Order.findById(orderId).lean()) as IOrder | null;
    if (!order) {
      console.warn(`${logPrefix} Order not found — skipping.`);
      return;
    }

    // Double-check the order is in a paid state (could have changed
    // between the trigger call and this async execution).
    if (!PAID_LIKE_STATUSES.has(order.status)) {
      console.warn(
        `${logPrefix} Order status is '${order.status}' (not paid) — skipping.`,
      );
      return;
    }

    // If the order already has design URLs, don't regenerate.
    // The admin can manually regenerate if they want fresh designs.
    if (order.designUrls && order.designUrls.length > 0) {
      console.log(
        `${logPrefix} Order already has ${order.designUrls.length} design URL(s) — skipping auto-generation.`,
      );
      return;
    }

    console.log(
      `${logPrefix} Starting auto design generation for order ${order.orderNumber} (status: ${order.status}).`,
    );

    const generated = await generateDesignsForOrder(order);

    console.log(
      `${logPrefix} Done: ${generated.generated.length} generated, ${generated.skipped.length} skipped.`,
    );
  } catch (error) {
    console.error(
      `${logPrefix} Unexpected error:`,
      error instanceof Error ? error.message : error,
    );
  }
}

/**
 * Core design generation logic — shared between the auto-trigger and
 * the admin manual route.
 *
 * For each product in the order, calls the design app to render the
 * matching template and upload the JPG to R2. Merges successful results
 * into the order's `designUrls` array.
 */
async function generateDesignsForOrder(order: IOrder): Promise<{
  generated: IOrderDesignUrl[];
  skipped: Array<{ productId: string; reason: string }>;
}> {
  // ── Check for a reservation photo ────────────────────────────────
  const reservationPhoto = order.reservationData?.find(
    (r) => r.key === 'photo' && r.value && r.value.trim().length > 0,
  );
  const hasReservationPhoto = Boolean(reservationPhoto);

  // ── Build the order data payload for the design app ──────────────
  const orderData = await buildOrderDataPayload(order);

  // ── Call the design app for each product ─────────────────────────
  const productItems = (order.items || []).filter((item) => item.productId);
  const results: DesignAppResult[] = [];

  for (let i = 0; i < productItems.length; i++) {
    const item = productItems[i];
    const productId = String(item.productId);
    const itemIndex = i + 1; // 1-based

    const itemOrderData = {
      ...orderData,
      item: {
        productId: item.productId,
        productName: item.productName,
        quantity: item.quantity,
        sizeIndex: item.sizeIndex,
        sizeName: item.sizeName,
      },
    };

    const result = await generateDesignForProduct({
      orderNumber: order.orderNumber,
      productId,
      hasReservationPhoto,
      itemIndex,
      orderData: itemOrderData,
    });
    results.push(result);
  }

  // ── Partition results ────────────────────────────────────────────
  const generated: IOrderDesignUrl[] = [];
  const skipped: Array<{ productId: string; reason: string }> = [];

  for (const result of results) {
    const item = productItems.find(
      (i) => String(i.productId) === result.productId,
    );
    const productName = item?.productName?.ar || item?.productName?.en || '';

    if (result.success && result.url) {
      generated.push({
        productId: result.productId,
        productName,
        url: result.url,
        templateType: result.templateType ?? 'text',
        projectId: result.projectId,
        createdAt: new Date(),
      });
    } else {
      skipped.push({
        productId: result.productId,
        reason: result.error || result.message || 'unknown',
      });
    }
  }

  // ── Merge into the order's designUrls ────────────────────────────
  if (generated.length > 0) {
    // Use updateOne with a filter that only adds if the productId
    // isn't already present — avoids race conditions with the admin
    // manually generating at the same time.
    const existing = (order.designUrls || []).filter(
      (d) => !generated.some((g) => g.productId === d.productId),
    );
    const merged = [...existing, ...generated];

    await Order.updateOne(
      { _id: order._id },
      { $set: { designUrls: merged } },
    );
  }

  return { generated, skipped };
}

/**
 * Build the order data payload sent to the design app.
 *
 * This is the same payload structure used by the admin manual route.
 * The design app's dynamic field resolver uses paths like
 * `billing.*`, `order.*`, `item.*`, `reservation.*`.
 */
async function buildOrderDataPayload(
  order: IOrder,
): Promise<Record<string, unknown>> {
  const reservation: Record<string, string> = {};
  if (Array.isArray(order.reservationData)) {
    for (const r of order.reservationData) {
      if (r.key && r.value) {
        reservation[r.key] = r.value;
      }
    }
  }

  let referrals: Array<{ referralId: string; phone: string; name: string }> =
    [];
  try {
    const allReferrals = await Referral.find().lean();
    referrals = allReferrals.map((r) => ({
      referralId: r.referralId,
      phone: r.phone,
      name: r.name,
    }));
  } catch {
    // Referral collection not available — skip
  }

  const referralId =
    order.referralId ||
    (order.source === 'ghadaq' ? 'GHD-D' : 'MNK-D');

  return {
    orderNumber: order.orderNumber,
    totalAmount: order.totalAmount,
    paidAmount: order.paidAmount,
    remainingAmount: order.remainingAmount,
    currency: order.currency,
    status: order.status,
    billingData: order.billingData,
    billing: order.billingData,
    items: order.items,
    item: order.items?.[0],
    reservationData: order.reservationData,
    reservation,
    source: order.source,
    locale: order.locale,
    referralId,
    referrals,
  };
}
