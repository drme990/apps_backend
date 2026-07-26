import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import Order, { type IOrder, type IOrderDesignUrl } from '@/lib/models/Order';
import { logActivity } from '@/lib/services/logger';
import {
  generateDesignForProduct,
  type DesignAppResult,
} from '@/lib/services/design-app-callback';

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/admin/orders/[id]/generate-design
 *
 * Triggers design generation for an order. For each product in the order,
 * the backend sends a callback to the design app, which renders the
 * matching booking template and uploads the JPG to R2.
 *
 * Flow:
 *   1. Verify admin auth (requires 'orders' page access).
 *   2. Load the order by ID.
 *   3. Check if the order has a reservation photo (determines whether
 *      the design app should use an 'image' template or a 'text' template).
 *   4. For each product in the order, call the design app callback.
 *      - Products without a template are skipped (the design app returns
 *        `noTemplate` and we continue with the next product).
 *      - Each successful result produces one design URL.
 *   5. Merge the new design URLs into the order's `designUrls` array
 *      (replacing any existing entries for the same productId so
 *      re-generation doesn't pile up duplicates).
 *   6. Save the order and return the results.
 *
 * Response:
 *   200 — {
 *     success: true,
 *     data: {
 *       orderNumber: string,
 *       generated: IOrderDesignUrl[],
 *       skipped: { productId, productName, reason }[],
 *     }
 *   }
 *   401/403 — auth failure
 *   404 — order not found
 *   500 — server error
 */
export async function POST(_request: NextRequest, { params }: RouteParams) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess(['orders']);
    if ('error' in auth) return auth.error;

    const { id } = await params;

    const order = (await Order.findById(id).lean()) as IOrder | null;
    if (!order) {
      return NextResponse.json(
        { success: false, error: { code: 'ERR_NOT_FOUND', message: 'Order not found' } },
        { status: 404 },
      );
    }

    // ── Check for a reservation photo ────────────────────────────────
    // The design app uses this flag to pick the right template variant:
    //   hasReservationPhoto=true  → 'image' template (if available)
    //   hasReservationPhoto=false → 'text' template
    const reservationPhoto = order.reservationData?.find(
      (r) => r.key === 'photo' && r.value && r.value.trim().length > 0,
    );
    const hasReservationPhoto = Boolean(reservationPhoto);

    // ── Build the order data payload for the design app ──────────────
    // The design app's dynamic field resolver expects paths like
    // `billing.fullName`, `order.orderNumber`, `reservation.photo`, etc.
    // We send the full order document so the renderer can resolve any
    // field without us having to map each one explicitly.
    const orderData = buildOrderDataPayload(order);

    // ── Call the design app for each product ─────────────────────────
    const productItems = (order.items || []).filter((item) => item.productId);
    const results: DesignAppResult[] = [];

    for (let i = 0; i < productItems.length; i++) {
      const item = productItems[i];
      const productId = String(item.productId);
      const itemIndex = i + 1; // 1-based

      // Build order data with the current item as `item` so that
      // `item.*` dynamic fields resolve to the right product.
      const itemOrderData = {
        ...orderData,
        item: {
          productId: item.productId,
          productName: item.productName,
          quantity: item.quantity,
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
    // `reasonCode` is a machine-readable code the admin panel maps to a
    // localized string. `reason` is an Arabic fallback for logs/non-i18n
    // callers.
    const skipped: Array<{
      productId: string;
      productName: string;
      reasonCode: string;
      reason: string;
    }> = [];

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
        // Map design-app error codes to machine-readable reasonCode +
        // Arabic fallback reason. The admin panel uses reasonCode to
        // show a localized message; reason is for logs/fallback.
        let reasonCode: string;
        let reason: string;
        switch (result.error) {
          case 'noTemplate':
            reasonCode = 'noTemplate';
            reason = 'لا يوجد قالب لهذا المنتج';
            break;
          case 'noBookingProduct':
            reasonCode = 'noBookingProduct';
            reason = 'المنتج غير مستورد في تطبيق التصميم';
            break;
          case 'templateNotFound':
            reasonCode = 'templateNotFound';
            reason = 'تم حذف القالب المرتبط بهذا المنتج';
            break;
          case 'designAppNotConfigured':
            reasonCode = 'designAppNotConfigured';
            reason = 'لم يتم ضبط رابط تطبيق التصميم';
            break;
          case 'callbackSecretNotConfigured':
            reasonCode = 'callbackSecretNotConfigured';
            reason = 'لم يتم ضبط مفتاح المصادقة لتطبيق التصميم';
            break;
          case 'timeout':
            reasonCode = 'timeout';
            reason = 'انتهت مهلة تطبيق التصميم';
            break;
          default:
            reasonCode = 'unknown';
            reason = result.message || result.error || 'فشل غير معروف';
        }
        skipped.push({ productId: result.productId, productName, reasonCode, reason });
      }
    }

    // ── Merge into the order's designUrls ────────────────────────────
    // Replace any existing entries for the same productId so re-running
    // the action doesn't pile up duplicates — the latest generation wins.
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

    // ── Log the action ───────────────────────────────────────────────
    try {
      await logActivity({
        action: 'generate_design',
        resource: 'order',
        resourceId: String(order._id),
        userId: auth.user.userId,
        userName: auth.user.name,
        userEmail: auth.user.email,
        details: JSON.stringify({
          orderNumber: order.orderNumber,
          generatedCount: generated.length,
          skippedCount: skipped.length,
          hasReservationPhoto,
        }),
      });
    } catch (logError) {
      // Logging is best-effort — don't fail the request if it errors
      console.error('[generate-design] logActivity failed:', logError);
    }

    return NextResponse.json({
      success: true,
      data: {
        orderNumber: order.orderNumber,
        generated,
        skipped,
      },
    });
  } catch (error) {
    console.error('[POST /api/admin/orders/[id]/generate-design]', error);
    return NextResponse.json(
      {
        success: false,
        error: {
          code: 'internalError',
          message: 'Failed to generate design',
        },
      },
      { status: 500 },
    );
  }
}

/**
 * Build the order data payload sent to the design app.
 *
 * The design app's dynamic field resolver uses paths that match the
 * `ORDER_FIELDS` definitions:
 *   - `billing.*`   → billingData.{fullName|email|phone|country}
 *   - `order.*`     → {orderNumber|totalAmount|paidAmount|...}
 *   - `item.*`      → items[0].{productName|quantity}
 *   - `reservation.*` → reservationData[key].value
 *
 * We send the raw order document (lean) plus a few convenience fields
 * the renderer can read directly without re-parsing the reservation
 * array.
 */
function buildOrderDataPayload(order: IOrder): Record<string, unknown> {
  // Flatten reservationData into a `reservation` object for easy
  // `reservation.photo` / `reservation.intention` lookups.
  const reservation: Record<string, string> = {};
  if (Array.isArray(order.reservationData)) {
    for (const r of order.reservationData) {
      if (r.key && r.value) {
        reservation[r.key] = r.value;
      }
    }
  }

  return {
    orderNumber: order.orderNumber,
    totalAmount: order.totalAmount,
    paidAmount: order.paidAmount,
    remainingAmount: order.remainingAmount,
    currency: order.currency,
    status: order.status,
    billingData: order.billingData,
    billing: order.billingData, // convenience alias
    items: order.items,
    item: order.items?.[0], // convenience: first item
    reservationData: order.reservationData,
    reservation, // convenience: flattened key→value
    source: order.source,
    locale: order.locale,
  };
}
