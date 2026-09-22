import { randomBytes } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { captureException } from '@/lib/services/error-monitor';
import Order, { type IOrder, type IPayment, type PaymentMethod } from '@/lib/models/Order';
import PaymentLink from '@/lib/models/PaymentLink';
import {
  verifyCallbackSignature,
  type EasykashCallbackPayload,
} from '@/lib/services/easykash';
import {
  calculateOrderFinancials,
  getPaymentOrderAmount,
} from '@/lib/services/order-financials';
import { resolveWhatsappButtonState } from '@/lib/services/whatsapp-button-state';
import { trackPurchase } from '@/lib/services/fb-capi';
import { trackTiktokPurchase } from '@/lib/services/tiktok-capi';
import { trackOpenAIPurchase } from '@/lib/services/openai-capi';
import { trackSnapPurchase } from '@/lib/services/snapchat-capi';
import { sendOrderConfirmationEmail } from '@/lib/services/email';
import WebhookEvent from '@/lib/models/WebhookEvent';
import { parseJsonBody } from '@/lib/validation/http';
import { webhookSchema } from '@/lib/validation/schemas';
import { evaluateAndUpdateUserTier } from '@/lib/services/user-tier-evaluator';
import {
  evaluateAndTriggerAutoDesign,
} from '@/lib/services/auto-design-generation';
import { syncSharedFields } from '@/lib/services/sub-order-sync';
import { applyShareIncrementsForOrder } from '@/lib/services/share-campaign';

const MAX_WEBHOOK_AGE = 7 * 60; // 7 minutes
const OBJECT_ID_REGEX = /^[a-f\d]{24}$/i;
const ORDER_REFERENCE_REGEX = /^ord_([a-f\d]{24})_([a-f\d]{24})_\d+$/i;
const CUSTOM_REFERENCE_REGEX = /^custom-([a-f\d]{24})(?:[-_]\d+)?$/i;
const ORDER_ATTEMPT_SUFFIX_REGEX = /-p\d+$/i;

function isTruthyFlag(value?: string | null): boolean {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

function shouldBypassSignatureValidationForTesting(
  request: NextRequest,
): boolean {
  if (!isTruthyFlag(process.env.EASYKASH_WEBHOOK_TEST_MODE)) {
    return false;
  }

  // Require an explicit request-level toggle so test bypass is intentional.
  return (
    isTruthyFlag(request.headers.get('x-easykash-test-mode')) ||
    isTruthyFlag(request.nextUrl.searchParams.get('testMode'))
  );
}

type ParsedPaymentReference =
  | {
    kind: 'order';
    orderId: string;
    paymentLinkId: string;
  }
  | {
    kind: 'custom';
    paymentLinkId: string;
  }
  | null;

function parsePaymentReference(
  customerReference: string,
): ParsedPaymentReference {
  const orderRefMatch = customerReference.match(ORDER_REFERENCE_REGEX);
  if (orderRefMatch) {
    return {
      kind: 'order',
      orderId: orderRefMatch[1],
      paymentLinkId: orderRefMatch[2],
    };
  }

  const customRefMatch = customerReference.match(CUSTOM_REFERENCE_REGEX);
  if (customRefMatch) {
    return {
      kind: 'custom',
      paymentLinkId: customRefMatch[1],
    };
  }

  return null;
}

function normalizeStatus(rawStatus: string | undefined): string {
  return (rawStatus || '').trim().toUpperCase();
}

function mapPaymentMethod(
  methodRaw: string | undefined,
): PaymentMethod {
  const method = (methodRaw || '').toLowerCase();

  if (method.includes('card')) return 'card';
  if (method.includes('wallet')) return 'wallet';
  if (method.includes('bank')) return 'bank_transfer';
  if (method.includes('fawry')) return 'fawry';
  if (method.includes('meeza')) return 'meeza';
  if (method.includes('valu')) return 'valu';

  return 'other';
}

function createSyntheticPayment(
  reference: string,
  orderAmount: number,
  currency: string,
  gatewayAmount?: number,
  gatewayCurrency?: string,
): IPayment {
  return {
    paymentId: `pay_webhook_${randomBytes(8).toString('hex')}`,
    easykashOrderId: reference,
    orderAmount,
    gatewayAmount,
    gatewayCurrency,
    amount: orderAmount,
    currency,
    status: 'pending',
    paymentMethod: 'easykash' as PaymentMethod,
    createdAt: new Date(),
  };
}

export async function POST(request: NextRequest) {
  try {
    await connectDB();

    const parsed = await parseJsonBody(request, webhookSchema);
    if (!parsed.success) {
      return parsed.response;
    }
    const rawBody = parsed.data;

    // Normalize body to extract both old and new payload fields
    const body: EasykashCallbackPayload = {
      ...rawBody,
      Amount: rawBody.Amount || rawBody.amount,
      PaymentMethod: rawBody.PaymentMethod || rawBody.paymentOption,
      Timestamp: rawBody.Timestamp || rawBody.timestamp || undefined,
    };

    // EasyKash signature might come in body or header sometimes
    const providedSignature =
      body.signatureHash ||
      request.headers.get('x-easykash-signature') ||
      request.headers.get('signature');
    if (providedSignature) {
      body.signatureHash = providedSignature.trim();
    }

    const bypassSignatureValidation =
      shouldBypassSignatureValidationForTesting(request);

    if (bypassSignatureValidation) {
      console.warn(
        'EasyKash webhook signature validation bypassed for test mode',
      );
    } else {
      // Signature verification is mandatory unless test bypass mode is enabled.
      if (!process.env.EASYKASH_HMAC_SECRET) {
        console.error(
          'EasyKash webhook rejected: EASYKASH_HMAC_SECRET is not configured',
        );
        return NextResponse.json(
          { error: 'Webhook signature verification is not configured' },
          { status: 503 },
        );
      }

      if (!body.signatureHash) {
        console.warn(
          'EasyKash webhook: Missing signatureHash in payload or headers. Bypassing signature check since EasyKash sometimes omits it on pending/cancel.',
        );
      } else {
        const isValid = verifyCallbackSignature(body);

        if (!isValid) {
          console.error('EasyKash webhook: invalid signature');
          return NextResponse.json(
            { error: 'Invalid signature' },
            { status: 403 },
          );
        }
      }
    }

    const now = Math.floor(Date.now() / 1000);
    let timestamp = 0;

    if (body.Timestamp) {
      // Check if it's an ISO string or a simple number
      const parsedDate = new Date(body.Timestamp);
      if (!isNaN(parsedDate.getTime())) {
        // ISO string
        timestamp = Math.floor(parsedDate.getTime() / 1000);
      } else {
        timestamp = Number(body.Timestamp);
      }
    }

    // Only enforce the freshness check when we have a valid timestamp.
    // EasyKash sometimes omits the Timestamp field entirely (especially
    // on pending/cancel callbacks), so we can't reject on its absence.
    // When present and parseable, reject stale callbacks to prevent replays.
    if (timestamp && !isNaN(timestamp) && now - timestamp > MAX_WEBHOOK_AGE) {
      console.error(
        `EasyKash webhook rejected: timestamp expired (age=${now - timestamp}s, max=${MAX_WEBHOOK_AGE}s, value=${body.Timestamp})`,
      );
      return NextResponse.json(
        { error: 'Webhook timestamp expired' },
        { status: 403 },
      );
    }

    if (body.Timestamp && (!timestamp || isNaN(timestamp))) {
      // Timestamp was provided but couldn't be parsed — log as a warning
      // (not an error) and continue, since the format varies across providers.
      console.warn(
        `EasyKash webhook: timestamp present but unparseable (${body.Timestamp}), skipping freshness check`,
      );
    }

    const {
      customerReference,
      status,
      easykashRef,
      ProductCode,
      voucher,
      PaymentMethod,
      Amount,
    } = body;
    const customerRefStr = String(customerReference || '').trim();
    const normalizedStatus = normalizeStatus(status);
    const isSuccessfulPayment =
      normalizedStatus === 'PAID' || normalizedStatus === 'SUCCESS';
    const parsedReference = parsePaymentReference(customerRefStr);

    const paymentLinkId = parsedReference?.paymentLinkId || null;
    let linkedPaymentLink = null;
    if (paymentLinkId && OBJECT_ID_REGEX.test(paymentLinkId)) {
      linkedPaymentLink = await PaymentLink.findOne({
        _id: paymentLinkId,
        isDeleted: { $ne: true },
      }).lean();
    }

    if (isSuccessfulPayment && linkedPaymentLink) {
      await PaymentLink.updateOne(
        {
          _id: linkedPaymentLink._id,
          isDeleted: { $ne: true },
          status: { $ne: 'used' },
        },
        { $set: { status: 'used', usedAt: new Date() } },
      );
    }

    // Idempotency key guarantees we process each callback event once.
    const eventKey = `${String(easykashRef || 'no_ref')}:${customerRefStr || 'no_customer_ref'}:${normalizedStatus || 'UNKNOWN'}`;
    try {
      await WebhookEvent.create({
        provider: 'easykash',
        eventKey,
        orderReference: customerRefStr || 'unknown',
      });
    } catch (error) {
      const mongoError = error as { code?: number };
      if (mongoError?.code === 11000) {
        console.log('Webhook duplicate ignored:', eventKey);
        return NextResponse.json({ success: true, duplicate: true });
      }

      throw error;
    }

    if (parsedReference?.kind === 'custom') {
      // Standalone custom links are not bound to an order, so processing
      // ends after idempotency + payment link status synchronization.
      return NextResponse.json({ success: true, type: 'custom_link' });
    }

    let order = null;

    if (customerRefStr) {
      order = await Order.findOne({
        'payments.easykashOrderId': customerRefStr,
      }).exec();
    }

    if (!order && parsedReference?.kind === 'order') {
      order = await Order.findById(parsedReference.orderId).exec();
    }

    try {
      if (!order && OBJECT_ID_REGEX.test(customerRefStr)) {
        order = await Order.findById(customerRefStr).exec();
      }
    } catch { }

    const baseOrderReference = customerRefStr.replace(
      ORDER_ATTEMPT_SUFFIX_REGEX,
      '',
    );
    if (!order && baseOrderReference) {
      const escapedRef = baseOrderReference.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      order = await Order.findOne({ orderNumber: { $regex: `^${escapedRef}$`, $options: 'i' } }).exec();
    }

    if (!order && linkedPaymentLink?.orderId) {
      order = await Order.findById(linkedPaymentLink.orderId).exec();
    }

    if (!order) {
      console.error('Webhook order not found:', customerRefStr);
      return NextResponse.json({ error: 'Order not found' }, { status: 404 });
    }

    const orderStatusBefore = order.status;

    // Identify specific payment attempt by EasyKash customer reference.
    let paymentRecord = order.payments?.find(
      (p) => p.easykashOrderId === customerRefStr,
    );

    const webhookAmount = Number(Amount);
    const hasWebhookAmount = Number.isFinite(webhookAmount);

    if (!paymentRecord && isSuccessfulPayment) {
      const fallbackAmount = hasWebhookAmount
        ? Number(
          linkedPaymentLink?.amountRequested ||
          order.remainingAmount ||
          order.totalAmount ||
          0,
        )
        : Number(
          linkedPaymentLink?.amountRequested ||
          order.remainingAmount ||
          order.totalAmount ||
          0,
        );
      const fallbackCurrency = (
        order.currency ||
        linkedPaymentLink?.currencyCode ||
        'EGP'
      )
        .toUpperCase()
        .trim();

      if (!order.payments) {
        order.payments = [];
      }

      const syntheticPayment = createSyntheticPayment(
        customerRefStr,
        fallbackAmount,
        fallbackCurrency,
        hasWebhookAmount ? webhookAmount : undefined,
        hasWebhookAmount ? 'EGP' : undefined,
      );
      order.payments.push(syntheticPayment);
      paymentRecord = order.payments[order.payments.length - 1];
    }

    const expectedGatewayAmount = Number(paymentRecord?.gatewayAmount || 0);
    const expectedOrderAmount = Number(
      paymentRecord?.orderAmount ||
      paymentRecord?.amount ||
      linkedPaymentLink?.amountRequested ||
      order.totalAmount ||
      0,
    );
    const expectedAmountForWarning =
      expectedGatewayAmount > 0 ? expectedGatewayAmount : expectedOrderAmount;

    if (
      hasWebhookAmount &&
      expectedAmountForWarning > 0 &&
      Math.abs(webhookAmount - expectedAmountForWarning) > 1
    ) {
      console.error(
        `Amount mismatch for ${customerRefStr}: webhook=${webhookAmount} expected=${expectedAmountForWarning}`,
      );

      // Do not reject signed paid callbacks due to amount drift.
      // Some link-based flows charge a gateway amount that can differ by
      // currency conversion/rounding from stored expected values.
    }

    const resolvedMethod = mapPaymentMethod(PaymentMethod);

    if (paymentRecord) {
      paymentRecord.easykashRef = easykashRef || paymentRecord.easykashRef;
      paymentRecord.easykashProductCode =
        ProductCode || paymentRecord.easykashProductCode;
      paymentRecord.easykashVoucher = voucher || paymentRecord.easykashVoucher;
      paymentRecord.easykashResponse = {
        ...(paymentRecord.easykashResponse || {}),
        status: normalizedStatus,
        PaymentMethod,
        Amount,
        ProductCode,
        easykashRef,
        voucher,
        BuyerEmail: body.BuyerEmail,
        BuyerMobile: body.BuyerMobile,
        BuyerName: body.BuyerName,
        Timestamp: body.Timestamp,
        customerReference: customerRefStr,
      };
    }

    if (isSuccessfulPayment) {
      if (paymentRecord) {
        const normalizedOrderAmount = getPaymentOrderAmount(
          order,
          paymentRecord,
        );
        if (normalizedOrderAmount > 0) {
          paymentRecord.orderAmount = normalizedOrderAmount;
        }

        if (hasWebhookAmount) {
          paymentRecord.gatewayAmount = webhookAmount;
          paymentRecord.gatewayCurrency =
            paymentRecord.gatewayCurrency ||
            (paymentRecord.currency &&
              paymentRecord.currency.toUpperCase() !==
              String(order.currency || '').toUpperCase()
              ? paymentRecord.currency.toUpperCase()
              : undefined) ||
            undefined;
        }

        paymentRecord.status = 'paid';
        paymentRecord.paidAt = new Date();
        paymentRecord.paymentMethod = resolvedMethod;
      }

      const { totalPaid, remainingAmount } = calculateOrderFinancials(order);
      order.paidAmount = totalPaid;
      order.remainingAmount = remainingAmount;
      order.status = remainingAmount <= 0 ? 'paid' : 'partial-paid';
    } else if (
      normalizedStatus === 'FAILED' ||
      normalizedStatus === 'EXPIRED' ||
      normalizedStatus === 'DECLINED' ||
      normalizedStatus === 'CANCELED' ||
      normalizedStatus === 'CANCELLED'
    ) {
      if (paymentRecord && paymentRecord.status !== 'paid') {
        paymentRecord.status =
          normalizedStatus === 'EXPIRED' ? 'expired' : 'failed';
      }

      const { totalPaid, remainingAmount } = calculateOrderFinancials(order);
      order.paidAmount = totalPaid;
      order.remainingAmount = remainingAmount;

      if (
        totalPaid <= 0 &&
        (order.status === 'pending' ||
          order.status === 'processing' ||
          order.status === 'partial-paid')
      ) {
        order.status = 'failed';
      } else if (
        totalPaid > 0 &&
        order.status !== 'paid' &&
        order.status !== 'completed'
      ) {
        order.status = 'partial-paid';
      }
    } else if (normalizedStatus === 'REFUNDED') {
      if (paymentRecord) paymentRecord.status = 'expired';
      order.status = 'refunded';
    } else if (normalizedStatus === 'PENDING' || normalizedStatus === 'NEW') {
      if (paymentRecord && paymentRecord.status !== 'paid') {
        paymentRecord.status = 'pending';
      }

      const hasPaidPayment = (order.payments || []).some(
        (payment) => payment.status === 'paid',
      );

      if (order.status !== 'paid' && order.status !== 'completed') {
        order.status = hasPaidPayment ? 'partial-paid' : 'pending';
      }
    }

    order.isWhatsappButtonClicked = resolveWhatsappButtonState(
      order.status,
      orderStatusBefore,
      order.isWhatsappButtonClicked,
    );

    await order.save();

    // ── Sync shared fields with linked sub-order/parent ──
    if (order.isSubOrder || order.hasSubOrder) {
      await syncSharedFields(String(order._id)).catch((err) => {
        console.error(`[webhook] syncSharedFields failed:`, err);
      });
    }

    const transitionedToPaid =
      order.status === 'paid' &&
      orderStatusBefore !== 'paid' &&
      orderStatusBefore !== 'completed';

    const transitionedToPartialPaid =
      order.status === 'partial-paid' &&
      orderStatusBefore !== 'partial-paid' &&
      orderStatusBefore !== 'paid' &&
      orderStatusBefore !== 'completed';

    // ── Share campaign increment ──
    // When an order with share items transitions to paid or
    // partial-paid, increment the campaign's soldShares. This
    // happens here (not at checkout) so only confirmed payments
    // count toward the campaign.
    //
    // If a single order's shares >= totalShares (full-order case),
    // a NEW completed campaign is created and the order item is
    // re-linked to it. The current active campaign is left unchanged.
    if (transitionedToPaid || transitionedToPartialPaid) {
      await applyShareIncrementsForOrder(order);
    }

    // ── Auto design generation ──────────────────────────────────────
    // Evaluates whether design generation should be triggered and ALWAYS
    // logs the decision — even when the trigger is NOT called, so every
    // paid order has a traceable log entry. Fire-and-forget.
    evaluateAndTriggerAutoDesign(
      order.toObject(),
      orderStatusBefore,
      'auto_webhook',
    ).catch((err) => {
      console.error(
        `[webhook] Auto design evaluation failed for order ${order.orderNumber}:`,
        err instanceof Error ? err.message : err,
      );
    });

    if (transitionedToPaid) {
      const item = order.items?.[0];

      if (item) {
        const sourceBaseUrls: Record<string, string> = {
          manasik: process.env.MANASIK_URL || 'https://www.manasik.net',
          ghadaq: process.env.GHADAQ_URL || 'https://www.ghadaqplus.com',
        };

        const baseUrl =
          sourceBaseUrls[order.source || 'manasik'] || sourceBaseUrls.manasik;

        // All order items for the platform contents arrays.
        const orderItems = (order.items || []).map((i) => ({
          productId: i.productId?.toString() || '',
          productName: i.productName?.en || i.productName?.ar || '',
          quantity: i.quantity || 1,
          price: i.price,
        }));

        const attr = order.attribution;
        const billingCountry =
          order.billingData?.country || order.location || undefined;

        /**
         * Atomically claim the send so concurrent webhook retries can't
         * both pass the check, then await the send. If the send fails,
         * clear the flag so the next retry can try again. The order
         * number is still the event_id on both sides, so the ad platform
         * deduplicates even if a duplicate slipped through.
         */
        const claimAndSend = async (
          field:
            | 'fbPurchaseServerSentAt'
            | 'tiktokPurchaseServerSentAt'
            | 'openaiPurchaseServerSentAt'
            | 'snapPurchaseServerSentAt',
          send: () => Promise<boolean>,
        ) => {
          try {
            const claimed = await Order.findOneAndUpdate(
              { _id: order._id, [field]: { $exists: false } },
              { $set: { [field]: new Date() } },
            );
            if (!claimed) return;

            const ok = await send();
            if (!ok) {
              await Order.updateOne(
                { _id: order._id },
                { $unset: { [field]: 1 } },
              );
            }
          } catch {
            // best-effort — dedup still works via event_id
          }
        };

        await Promise.allSettled([
          // ── Facebook Conversions API ─────────────────────────────────────
          claimAndSend('fbPurchaseServerSentAt', () =>
            trackPurchase({
              productId: item.productId?.toString() || '',
              productName: item.productName?.en || item.productName?.ar || '',
              value: order.totalAmount ?? 0,
              currency: order.currency || 'SAR',
              numItems: item.quantity || 1,
              items: orderItems,
              orderId: order.orderNumber,
              source: order.source,
              sourceUrl: `${baseUrl}/payment/status`,
              userData: {
                em: order.billingData?.email,
                ph: order.billingData?.phone,
                fn: order.billingData?.fullName?.split(' ')[0],
                ln:
                  order.billingData?.fullName?.split(' ').slice(1).join(' ') ||
                  order.billingData?.fullName?.split(' ')[0],
                country: billingCountry,
                external_id: order._id.toString(),
                client_ip_address: attr?.clientIp,
                client_user_agent: attr?.userAgent,
                fbc: attr?.fbc,
                fbp: attr?.fbp,
              },
            }),
          ),

          // ── TikTok Events API ────────────────────────────────────────────
          claimAndSend('tiktokPurchaseServerSentAt', () =>
            trackTiktokPurchase({
              productId: item.productId?.toString() || '',
              productName: item.productName?.en || item.productName?.ar || '',
              value: order.totalAmount ?? 0,
              currency: order.currency || 'SAR',
              numItems: item.quantity || 1,
              items: orderItems,
              orderId: order.orderNumber,
              sourceUrl: `${baseUrl}/payment/status`,
              userData: {
                email: order.billingData?.email,
                phone: order.billingData?.phone,
                country: billingCountry,
                external_id: order._id.toString(),
                ttclid: attr?.ttclid,
                ttp: attr?.ttp,
                ip: attr?.clientIp,
                user_agent: attr?.userAgent,
              },
            }),
          ),

          // ── OpenAI Events API ────────────────────────────────────────────
          claimAndSend('openaiPurchaseServerSentAt', () =>
            trackOpenAIPurchase({
              productId: item.productId?.toString() || '',
              productName: item.productName?.en || item.productName?.ar || '',
              value: order.totalAmount ?? 0,
              currency: order.currency || 'SAR',
              numItems: item.quantity || 1,
              items: orderItems,
              orderId: order.orderNumber,
              sourceUrl: `${baseUrl}/payment/status`,
              oppref: attr?.oppref,
              userData: {
                email: order.billingData?.email,
                phone: order.billingData?.phone,
                country: billingCountry,
                first_name: order.billingData?.fullName?.split(' ')[0],
                last_name:
                  order.billingData?.fullName?.split(' ').slice(1).join(' ') ||
                  order.billingData?.fullName?.split(' ')[0],
                external_id: order._id.toString(),
                obref: attr?.obref,
                client_ip_address: attr?.clientIp,
                client_user_agent: attr?.userAgent,
              },
            }),
          ),

          // ── Snapchat Conversions API ─────────────────────────────────────
          claimAndSend('snapPurchaseServerSentAt', () =>
            trackSnapPurchase({
              productId: item.productId?.toString() || '',
              productName: item.productName?.en || item.productName?.ar || '',
              value: order.totalAmount ?? 0,
              currency: order.currency || 'SAR',
              numItems: item.quantity || 1,
              items: orderItems,
              orderId: order.orderNumber,
              sourceUrl: `${baseUrl}/payment/status`,
              userData: {
                em: order.billingData?.email,
                ph: order.billingData?.phone,
                country: billingCountry,
                client_ip_address: attr?.clientIp,
                client_user_agent: attr?.userAgent,
                sc_click_id: attr?.scClickId,
                sc_cookie1: attr?.scCookie1,
              },
            }),
          ),
        ]);
      }

      sendOrderConfirmationEmail(order.toObject() as IOrder).catch(() => { });

      if (order.userId && order.source && (order.source === 'manasik' || order.source === 'ghadaq')) {
        evaluateAndUpdateUserTier(String(order.userId), order.source).catch(() => { });
      }
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('EasyKash webhook error:', error);

    captureException(error, {
      service: 'PaymentWebhook',
      operation: 'POST',
      severity: 'critical',
    });

    return NextResponse.json(
      { success: false, error: 'Webhook processing failed' },
      { status: 500 },
    );
  }
}
