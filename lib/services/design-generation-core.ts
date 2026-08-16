/**
 * Shared design generation core.
 *
 * This is the SINGLE source of truth for generating designs for an order.
 * Both the auto-trigger (payment webhook / admin status change) and the
 * manual trigger (admin "Generate Design" button) call this function.
 *
 * This ensures the auto path behaves identically to the manual path —
 * if the manual button works, the auto trigger works too.
 */

import Order, { type IOrder, type IOrderDesignUrl } from '@/lib/models/Order';
import Referral from '@/lib/models/Referral';
import {
  generateDesignForProduct,
  type DesignAppResult,
} from '@/lib/services/design-app-callback';
import type { IOrderDesignLogResult } from '@/lib/models/OrderDesignLog';

export interface DesignGenerationResult {
  /** Successfully generated design URLs to merge into the order */
  generated: IOrderDesignUrl[];
  /** Products that were skipped (no template, errors, etc.) */
  skipped: Array<{
    productId: string;
    productName: string;
    reasonCode: string;
    reason: string;
  }>;
  /** Per-product results for logging */
  logResults: IOrderDesignLogResult[];
  /** Whether the order has a reservation photo (determines template type) */
  hasReservationPhoto: boolean;
}

/**
 * Map design-app error codes to machine-readable reasonCode +
 * Arabic fallback reason. The admin panel uses reasonCode to show
 * a localized message; reason is for logs/fallback.
 */
function mapDesignError(
  result: DesignAppResult,
): { reasonCode: string; reason: string } {
  switch (result.error) {
    case 'noTemplate':
      return { reasonCode: 'noTemplate', reason: 'لا يوجد قالب لهذا المنتج' };
    case 'noBookingProduct':
      return { reasonCode: 'noBookingProduct', reason: 'المنتج غير مستورد في تطبيق التصميم' };
    case 'templateNotFound':
      return { reasonCode: 'templateNotFound', reason: 'تم حذف القالب المرتبط بهذا المنتج' };
    case 'designAppNotConfigured':
      return { reasonCode: 'designAppNotConfigured', reason: 'لم يتم ضبط رابط تطبيق التصميم' };
    case 'callbackSecretNotConfigured':
      return { reasonCode: 'callbackSecretNotConfigured', reason: 'لم يتم ضبط مفتاح المصادقة لتطبيق التصميم' };
    case 'timeout':
      return { reasonCode: 'timeout', reason: 'انتهت مهلة تطبيق التصميم' };
    case 'fetchFailed':
      return { reasonCode: 'fetchFailed', reason: result.message || 'فشل الاتصال بتطبيق التصميم' };
    default:
      return { reasonCode: 'unknown', reason: result.message || result.error || 'فشل غير معروف' };
  }
}

/**
 * Generate designs for all products in an order.
 *
 * For each product item:
 *   1. Builds the order data payload (billing, reservation, referrals, etc.)
 *   2. Calls the design app to render the template → JPG → R2 upload
 *   3. Collects the result (success with URL, or failure with error code)
 *
 * After all products are processed, merges successful design URLs into
 * the order's `designUrls` array (replacing any existing entries for the
 * same productId so re-runs don't pile up duplicates).
 *
 * @param order The full order document (lean)
 * @returns Generation results — generated URLs, skipped products, and
 *          per-product log results
 */
export async function generateDesignsForOrder(
  order: IOrder,
): Promise<DesignGenerationResult> {
  // ── Check for a reservation photo ────────────────────────────────
  const reservationPhoto = order.reservationData?.find(
    (r) => r.key === 'photo' && r.value && r.value.trim().length > 0,
  );
  const hasReservationPhoto = Boolean(reservationPhoto);

  // ── Build the order data payload for the design app ──────────────
  const orderData = await buildOrderDataPayload(order);

  // ── Call the design app for all products in parallel ─────────────
  // Instead of rendering products one-by-one (which doubles the time
  // for 2-product orders), we fire all requests simultaneously. The
  // design app's concurrency limiter handles queueing on its end —
  // this just ensures we don't add extra sequential wait time on the
  // backend side.
  const productItems = (order.items || []).filter((item) => item.productId);

  const buildItemOrderData = (item: (typeof productItems)[number]) => ({
    ...orderData,
    item: {
      productId: item.productId,
      productName: item.productName,
      quantity: item.quantity,
      sizeIndex: item.sizeIndex,
      sizeName: item.sizeName,
      sizeDesignName: item.sizeDesignName || '',
    },
  });

  const settled = await Promise.allSettled(
    productItems.map((item, i) => {
      const productId = String(item.productId);
      const itemIndex = i + 1; // 1-based

      return generateDesignForProduct({
        orderNumber: order.orderNumber,
        productId,
        hasReservationPhoto,
        itemIndex,
        orderData: buildItemOrderData(item),
      });
    }),
  );

  // Map settled results back to DesignAppResult[], treating rejections
  // as failures so the partition logic below handles them uniformly.
  const results: DesignAppResult[] = settled.map((s, i) => {
    if (s.status === 'fulfilled') return s.value;
    return {
      success: false,
      productId: String(productItems[i].productId),
      error: 'fetchFailed',
      message: s.reason instanceof Error ? s.reason.message : String(s.reason),
    };
  });

  // ── Retry timed-out products once ─────────────────────────────────
  // A timeout usually means the design app's render queue was full at
  // the time of the request. By the time the first attempt times out,
  // the queue has likely cleared. We retry just the timed-out products
  // once — no retry for other errors (noTemplate, noBookingProduct,
  // etc.) since those won't fix themselves.
  const timedOutIndices = results
    .map((r, i) => (r.error === 'timeout' ? i : -1))
    .filter((i) => i >= 0);

  if (timedOutIndices.length > 0) {
    console.log(
      `[design-gen order=${order.orderNumber}] Retrying ${timedOutIndices.length} timed-out product(s)…`,
    );

    const retrySettled = await Promise.allSettled(
      timedOutIndices.map((idx) => {
        const item = productItems[idx];
        return generateDesignForProduct({
          orderNumber: order.orderNumber,
          productId: String(item.productId),
          hasReservationPhoto,
          itemIndex: idx + 1,
          orderData: buildItemOrderData(item),
        });
      }),
    );

    // Replace timed-out results with retry results
    timedOutIndices.forEach((idx, retryIdx) => {
      const s = retrySettled[retryIdx];
      if (s.status === 'fulfilled') {
        results[idx] = s.value;
      } else {
        // Keep the original timeout error — retry also failed
        results[idx] = {
          ...results[idx],
          message: `Retry also failed: ${s.reason instanceof Error ? s.reason.message : String(s.reason)}`,
        };
      }
    });
  }

  // ── Partition results ────────────────────────────────────────────
  const generated: IOrderDesignUrl[] = [];
  const skipped: Array<{ productId: string; productName: string; reasonCode: string; reason: string }> = [];
  const logResults: IOrderDesignLogResult[] = [];

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
        reviewed: false,
      });
      logResults.push({
        productId: result.productId,
        productName,
        success: true,
        url: result.url,
        templateType: result.templateType ?? 'text',
        projectId: result.projectId,
      });
    } else {
      const { reasonCode, reason } = mapDesignError(result);
      skipped.push({ productId: result.productId, productName, reasonCode, reason });
      logResults.push({
        productId: result.productId,
        productName,
        success: false,
        errorCode: reasonCode,
        errorMessage: reason,
      });
    }
  }

  // ── Merge into the order's designUrls ────────────────────────────
  // Replace any existing entries for the same productId so re-running
  // doesn't pile up duplicates — the latest generation wins.
  if (generated.length > 0) {
    const existing = (order.designUrls || []).filter(
      (d) => !generated.some((g) => g.productId === d.productId),
    );
    const merged = [...existing, ...generated];

    await Order.updateOne(
      { _id: order._id },
      { $set: { designUrls: merged } },
    );
  }

  return { generated, skipped, logResults, hasReservationPhoto };
}

/**
 * Build the order data payload sent to the design app.
 *
 * The design app's dynamic field resolver uses paths like
 * `billing.*`, `order.*`, `item.*`, `reservation.*`, `ref.*`.
 */
export async function buildOrderDataPayload(
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
    // Order's creation timestamp (ms since epoch) — stored on the design
    // instance's orderMeta so the design app can sort designs in the same
    // order as the execution page (which sorts by order.createdAt asc).
    orderCreatedAt: order.createdAt instanceof Date ? order.createdAt.getTime() : undefined,
  };
}
