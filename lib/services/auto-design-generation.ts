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
 *   2. Design generation can take 10-120s per product (canvas render +
 *      R2 upload), and an order may have multiple products.
 *
 * The actual generation logic lives in `design-generation-core.ts` and
 * is shared with the admin manual "Generate Design" button. This means
 * the auto path behaves identically to the manual path — if the button
 * works, the auto trigger works too.
 *
 * If auto-generation fails, the admin can still trigger it manually via
 * the "Generate Design" button — that route is unaffected.
 *
 * Re-generation guard:
 *   We only trigger when the order FIRST enters a paid state. If the
 *   order was already `partial-paid` and transitions to `paid`, we do
 *   NOT regenerate — the design was already created at `partial-paid`.
 *
 * Burst protection:
 *   When a batch of payments settles simultaneously (e.g. EasyKash
 *   reconciles a batch), the webhook fires N auto-generation calls at
 *   once. Without a queue, all N hit the design app simultaneously,
 *   filling its render queue. Later requests wait so long they hit
 *   the backend's 300s timeout — even though the render itself only
 *   takes 7-30s. The `autoGenQueue` below caps how many orders are
 *   processed at once (default 3), keeping the design app's queue
 *   short and each request within the timeout window.
 */

import { connectDB } from '@/lib/db';
import Order, { type IOrder } from '@/lib/models/Order';
import { generateDesignsForOrder } from '@/lib/services/design-generation-core';
import { recordDesignGenLog, type DesignGenTrigger } from '@/lib/services/design-log-service';

/** Statuses that count as "already paid" — no need to auto-generate. */
export const PAID_LIKE_STATUSES = new Set(['paid', 'partial-paid', 'completed']);

// ── Backend-side auto-generation queue ──────────────────────────────
// Limits how many orders are sent to the design app simultaneously.
// The design app has its own render limiter (10 concurrent), but if
// 50 orders fire at once, 50 requests pile up in the design app's
// queue — the last ones wait 50/10 × 30s = 150s before they even
// START rendering, then another 30s to render = 180s total. With
// slower renders or more orders, this exceeds the 300s timeout.
//
// By processing only 3 orders at a time on the backend side, the
// design app's queue stays short (at most 3 orders × ~2 products =
// 6 renders queued), and each request completes well within the
// timeout. Excess orders wait in the backend's queue — they don't
// hold any design-app resources while waiting.
const AUTO_GEN_CONCURRENCY = parseInt(
  process.env.AUTO_GEN_CONCURRENCY || '3',
  10,
);
let autoGenActive = 0;
const autoGenQueue: Array<() => void> = [];

async function acquireAutoGenSlot(): Promise<void> {
  if (autoGenActive < AUTO_GEN_CONCURRENCY) {
    autoGenActive++;
    return;
  }
  await new Promise<void>((resolve) => autoGenQueue.push(resolve));
  autoGenActive++;
}

function releaseAutoGenSlot(): void {
  const next = autoGenQueue.shift();
  if (next) {
    next(); // hand the slot to the next waiter
  } else {
    autoGenActive--;
  }
}

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
 * Check if an order needs design generation but doesn't have all of them.
 *
 * This catches cases where:
 *   - The order transitioned to paid but the initial auto-generation
 *     failed (fire-and-forget promise was killed by a serverless
 *     timeout, network error, etc.)
 *   - The order was already partial-paid with no designs and later
 *     transitions to paid (shouldTriggerAutoDesignGeneration returns
 *     false for this case, but the order still needs designs)
 *   - The order has SOME designs but is missing others (partial
 *     failure — one product had no template, the generation was killed
 *     mid-way, etc.)
 *
 * When `items` is provided, this checks per-product: every item with a
 * `productId` should have a matching entry in `designUrls`. If any
 * product is missing its design, the order needs generation.
 *
 * When `items` is NOT provided (backward compat with old callers),
 * this falls back to the original behavior: needs generation if
 * `designUrls` is empty.
 *
 * The actual generation function (triggerAutoDesignGeneration) already
 * skips orders that have ALL designs, so calling it extra times is safe.
 */
export function needsDesignGeneration(
  status: string,
  designUrls: Array<{ url?: string; productId?: string }> | undefined | null,
  items?: Array<{ productId?: unknown }> | undefined | null,
): boolean {
  if (!PAID_LIKE_STATUSES.has(status)) return false;

  // If items is provided, check per-product gaps
  if (items) {
    const productsWithId = items.filter((i) => i.productId);
    if (productsWithId.length === 0) return false;
    const generatedProductIds = new Set(
      (designUrls || []).map((d) => String(d.productId)),
    );
    // Re-trigger if ANY product is missing its design
    return productsWithId.some(
      (i) => !generatedProductIds.has(String(i.productId)),
    );
  }

  // Backward compat: no items → needs generation if designUrls is empty
  return !designUrls || designUrls.length === 0;
}

/**
 * Evaluate whether auto-design generation should be triggered for an
 * order, trigger it if needed, and ALWAYS log the decision — even when
 * the trigger is NOT called. This ensures every paid order has a
 * traceable log entry explaining why designs were or weren't generated.
 *
 * Call this at every status-change site (webhook, admin PUT, admin PATCH,
 * manual order creation) instead of manually checking
 * shouldTriggerAutoDesignGeneration + needsDesignGeneration.
 *
 * @param order       The order document (must have _id, orderNumber,
 *                    status, designUrls, source, items)
 * @param previousStatus  The status BEFORE the transition
 * @param trigger     Who/what triggered this evaluation
 */
export async function evaluateAndTriggerAutoDesign(
  order: {
    _id: unknown;
    orderNumber: string;
    status: string;
    designUrls?: Array<{ url?: string; productId?: string }> | null;
    items?: Array<{ productId?: unknown }> | null;
    source?: string;
  },
  previousStatus: string,
  trigger: 'auto_webhook' | 'auto_admin',
): Promise<void> {
  const startedAt = new Date();
  const orderId = String(order._id);
  const logPrefix = `[auto-design-eval order=${order.orderNumber}]`;

  const shouldTrigger = shouldTriggerAutoDesignGeneration(
    previousStatus,
    order.status,
  );
  const needsDesign = needsDesignGeneration(
    order.status,
    order.designUrls,
    order.items,
  );

  if (shouldTrigger || needsDesign) {
    // Trigger generation — fire-and-forget
    triggerAutoDesignGeneration(orderId, trigger).catch((err) => {
      console.error(
        `${logPrefix} Auto design generation failed:`,
        err instanceof Error ? err.message : err,
      );
    });
    return;
  }

  // ── Log WHY we didn't trigger ──────────────────────────────────
  // This is the key fix: previously, when the trigger was NOT called,
  // no log entry was created at all — making it impossible to debug
  // missing designs. Now we always log the decision.
  let skipReason: string;

  if (!PAID_LIKE_STATUSES.has(order.status)) {
    skipReason = `Status '${order.status}' is not a paid-like status — no design generation needed`;
  } else if (!needsDesign) {
    // needsDesign was false → all products have designs
    const designCount = order.designUrls?.length ?? 0;
    const itemCount = (order.items || []).filter((i) => i.productId).length;
    skipReason = `Order already has ${designCount}/${itemCount} design URL(s) — all products covered, no regeneration needed`;
  } else if (PAID_LIKE_STATUSES.has(previousStatus)) {
    skipReason = `Status was already '${previousStatus}' (paid-like) → '${order.status}' — no new transition, and order already has designs or was already processed`;
  } else {
    skipReason = `No trigger condition met (prev='${previousStatus}', new='${order.status}', designs=${order.designUrls?.length ?? 0})`;
  }

  console.log(`${logPrefix} Skipping: ${skipReason}`);

  // Record the skip in the design log so it's visible in the admin panel
  recordDesignGenLog({
    orderId,
    orderNumber: order.orderNumber,
    source: order.source,
    orderStatus: order.status,
    trigger,
    startedAt,
    finishedAt: new Date(),
    results: [],
    skipReason,
  }).catch((err) => {
    console.error(
      `${logPrefix} Failed to write skip log:`,
      err instanceof Error ? err.message : err,
    );
  });
}

/**
 * Trigger automatic design generation for an order.
 *
 * This is fire-and-forget — the caller should NOT await it.
 * It runs entirely in the background and logs results to the
 * OrderDesignLog collection (visible in the admin panel's design logs page).
 *
 * @param orderId The MongoDB _id of the order (string or ObjectId)
 * @param trigger Who/what triggered this — 'auto_webhook' (payment
 *                webhook) or 'auto_admin' (admin status change).
 */
export async function triggerAutoDesignGeneration(
  orderId: string,
  trigger: 'auto_webhook' | 'auto_admin' = 'auto_webhook',
): Promise<void> {
  const logPrefix = `[auto-design-gen order=${orderId}]`;
  const startedAt = new Date();

  // Wait for a backend-side slot before doing anything. This keeps
  // the design app's render queue short even when a burst of orders
  // transitions to paid simultaneously.
  await acquireAutoGenSlot();

  try {
    await connectDB();

    const order = (await Order.findById(orderId).lean()) as IOrder | null;
    if (!order) {
      console.warn(`${logPrefix} Order not found — skipping.`);
      // Record the skip so the admin can see the trigger fired
      await recordDesignGenLog({
        orderId,
        orderNumber: 'unknown',
        trigger,
        startedAt,
        finishedAt: new Date(),
        results: [],
        skipReason: 'Order not found',
      });
      return;
    }

    // Double-check the order is still in a paid state (could have
    // changed between the trigger call and this async execution).
    if (!PAID_LIKE_STATUSES.has(order.status)) {
      console.warn(
        `${logPrefix} Order status is '${order.status}' (not paid) — skipping.`,
      );
      // Record the skip so the admin can see the trigger fired
      await recordDesignGenLog({
        orderId: String(order._id),
        orderNumber: order.orderNumber,
        source: order.source,
        orderStatus: order.status,
        trigger,
        startedAt,
        finishedAt: new Date(),
        results: [],
        skipReason: `Order status is '${order.status}' (not paid)`,
      });
      return;
    }

    // If the order already has ALL designs (one per product with a
    // productId), don't regenerate. But if it has SOME designs and is
    // missing others (partial failure), continue — the generation core
    // merges by productId and the design app deduplicates by
    // operationId, so re-running only fills the gaps.
    if (!needsDesignGeneration(order.status, order.designUrls, order.items)) {
      const designCount = (order.designUrls || []).length;
      const itemCount = (order.items || []).filter((i) => i.productId).length;
      console.log(
        `${logPrefix} Order already has ${designCount}/${itemCount} design URL(s) — skipping.`,
      );
      // Record the skip so the admin can see the trigger fired
      await recordDesignGenLog({
        orderId: String(order._id),
        orderNumber: order.orderNumber,
        source: order.source,
        orderStatus: order.status,
        trigger,
        startedAt,
        finishedAt: new Date(),
        results: [],
        skipReason: `Order already has ${designCount}/${itemCount} design URL(s) — all products covered`,
      });
      return;
    }

    console.log(
      `${logPrefix} Starting auto design generation for order ${order.orderNumber} (status: ${order.status}).`,
    );

    // ── Generate designs (shared core — same logic as the manual button)
    // Auto generation uses a stable operationId prefix per order so webhook
    // retries (or duplicate status-change events) don't create duplicate
    // saved versions — the design app deduplicates by operationId.
    const { generated, skipped, logResults, hasReservationPhoto } =
      await generateDesignsForOrder(order, {
        trigger: 'auto',
        operationIdPrefix: `auto:${order.orderNumber}`,
      });

    console.log(
      `${logPrefix} Done: ${generated.length} generated, ${skipped.length} skipped.`,
    );

    // ── Record the log entry
    await recordDesignGenLog({
      orderId: String(order._id),
      orderNumber: order.orderNumber,
      source: order.source,
      orderStatus: order.status,
      hasReservationPhoto,
      trigger,
      startedAt,
      finishedAt: new Date(),
      results: logResults,
    });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`${logPrefix} Unexpected error:`, errorMsg);

    // Best-effort: try to record the error in the log
    try {
      await connectDB();
      const order = (await Order.findById(orderId).lean()) as IOrder | null;
      await recordDesignGenLog({
        orderId,
        orderNumber: order?.orderNumber || 'unknown',
        source: order?.source,
        orderStatus: order?.status,
        trigger,
        startedAt,
        finishedAt: new Date(),
        results: [],
        error: errorMsg,
      });
    } catch {
      // If even the log write fails, the console.error above is enough
    }
  } finally {
    releaseAutoGenSlot();
  }
}

/**
 * Trigger design re-generation after a non-status order edit.
 *
 * Unlike the auto-payment trigger, this always re-renders for existing
 * products (it does not skip when designUrls already exist). It is still
 * fire-and-forget and uses the same backend queue so bursts of admin edits
 * don't overwhelm the design app.
 *
 * It runs for any paid/partial-paid/completed order, or for any order that
 * already has generated designs, so existing designs are refreshed when the
 * admin changes names, duaa, reservation data, or items.
 */
export async function triggerDesignRegeneration(
  orderId: string,
  trigger: DesignGenTrigger = 'auto_admin',
): Promise<void> {
  const logPrefix = `[design-regen order=${orderId}]`;
  const startedAt = new Date();

  await acquireAutoGenSlot();

  try {
    await connectDB();

    const order = (await Order.findById(orderId).lean()) as IOrder | null;
    if (!order) {
      console.warn(`${logPrefix} Order not found — skipping.`);
      await recordDesignGenLog({
        orderId,
        orderNumber: 'unknown',
        trigger,
        startedAt,
        finishedAt: new Date(),
        results: [],
        skipReason: 'Order not found',
      });
      return;
    }

    const hasExistingDesigns = (order.designUrls || []).length > 0;
    const isPaid = PAID_LIKE_STATUSES.has(order.status);
    if (!isPaid && !hasExistingDesigns) {
      console.log(
        `${logPrefix} Order status is '${order.status}' and has no designs — skipping.`,
      );
      await recordDesignGenLog({
        orderId: String(order._id),
        orderNumber: order.orderNumber,
        source: order.source,
        orderStatus: order.status,
        trigger,
        startedAt,
        finishedAt: new Date(),
        results: [],
        skipReason: `Order status is '${order.status}' and has no designs`,
      });
      return;
    }

    console.log(
      `${logPrefix} Starting design re-generation for order ${order.orderNumber} (status: ${order.status}).`,
    );

    const { generated, skipped, logResults, hasReservationPhoto } =
      await generateDesignsForOrder(order, {
        // Re-generation after an admin edit is still 'auto' from the
        // history's perspective — it's not an admin clicking "Regenerate".
        // A fresh operationId prefix per call so each re-generation is a
        // distinct event (the admin might edit the order multiple times).
        trigger: 'auto',
        operationIdPrefix: `autoregen:${order.orderNumber}:${Date.now()}`,
      });

    console.log(
      `${logPrefix} Done: ${generated.length} generated, ${skipped.length} skipped.`,
    );

    await recordDesignGenLog({
      orderId: String(order._id),
      orderNumber: order.orderNumber,
      source: order.source,
      orderStatus: order.status,
      hasReservationPhoto,
      trigger,
      startedAt,
      finishedAt: new Date(),
      results: logResults,
    });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`${logPrefix} Unexpected error:`, errorMsg);

    try {
      await connectDB();
      const order = (await Order.findById(orderId).lean()) as IOrder | null;
      await recordDesignGenLog({
        orderId,
        orderNumber: order?.orderNumber || 'unknown',
        source: order?.source,
        orderStatus: order?.status,
        trigger,
        startedAt,
        finishedAt: new Date(),
        results: [],
        error: errorMsg,
      });
    } catch {
      // logging failed — already console.error'd above
    }
  } finally {
    releaseAutoGenSlot();
  }
}
