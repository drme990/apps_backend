import { NextRequest, NextResponse } from 'next/server';
import type { HydratedDocument } from 'mongoose';
import { connectDB } from '@/lib/db';
import Order, {
  type IOrder,
  type IPayment,
  type PaymentMethod,
} from '@/lib/models/Order';
import {
  verifyCallbackSignature,
  type EasykashCallbackPayload,
  mapEasykashStatusToOrderStatus,
} from '@/lib/services/easykash';
import { trackPurchase } from '@/lib/services/fb-capi';
import { sendOrderConfirmationEmail } from '@/lib/services/email';
import { captureException } from '@/lib/services/error-monitor';
import WebhookEvent from '@/lib/models/WebhookEvent';
import PaymentLink from '@/lib/models/PaymentLink';
import { webhookSchema } from '@/lib/validation/schemas';
import TerminalLog from '@/lib/models/TerminalLog';

const MAX_WEBHOOK_AGE = 7 * 60; // 7 minutes
const OBJECT_ID_REGEX = /^[a-f\d]{24}$/i;
const ORDER_REF_REGEX = /^ord_([a-f\d]{24})_[a-f\d]{24}_\d+$/i;
const ORDER_LINK_REF_REGEX = /^ord_([a-f\d]{24})_([a-f\d]{24})_\d+$/i;
const CUSTOM_LINK_REF_REGEX = /^custom-([a-f\d]{24})$/i;

function stripPaymentAttemptSuffix(reference: string | undefined): string {
  if (!reference) return '';
  return reference.replace(/-p\d+$/i, '');
}

function getOrderIdFromReference(
  customerReference: string | undefined,
): string | null {
  if (!customerReference) return null;

  if (OBJECT_ID_REGEX.test(customerReference)) {
    return customerReference;
  }

  const prefixedMatch = customerReference.match(ORDER_REF_REGEX);
  if (prefixedMatch) {
    return prefixedMatch[1];
  }

  return null;
}

function getPaymentMethodFromString(methodStr: string): PaymentMethod {
  const methodLower = (methodStr || '').toLowerCase();

  if (methodLower.includes('card')) return 'card';
  if (methodLower.includes('wallet')) return 'wallet';
  if (methodLower.includes('fawry')) return 'fawry';
  if (methodLower.includes('meeza')) return 'meeza';
  if (methodLower.includes('valu')) return 'valu';
  return 'other';
}

function getPaymentLinkIdFromReference(
  customerReference: string | undefined,
): string | null {
  if (!customerReference) return null;

  const orderLinkMatch = customerReference.match(ORDER_LINK_REF_REGEX);
  if (orderLinkMatch?.[2]) {
    return orderLinkMatch[2];
  }

  const customLinkMatch = customerReference.match(CUSTOM_LINK_REF_REGEX);
  if (customLinkMatch?.[1]) {
    return customLinkMatch[1];
  }

  return null;
}

export async function POST(request: NextRequest) {
  const rawBody = await request.clone().text();
  const requestHeaders = Object.fromEntries(request.headers.entries());
  const auditPayload: Record<string, unknown> = {
    route: '/api/payment/webhook',
    method: request.method,
    url: request.nextUrl.pathname,
    search: request.nextUrl.search,
    headers: requestHeaders,
    rawBody,
    parsedBody: null,
    validationStage: 'received',
  };

  try {
    await connectDB();

    let parsedBody: unknown;
    try {
      parsedBody = rawBody ? JSON.parse(rawBody) : null;
    } catch {
      auditPayload.validationStage = 'invalid_json';
      auditPayload.result = 'rejected';
      auditPayload.responseStatus = 400;
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const parsed = webhookSchema.safeParse(parsedBody);
    if (!parsed.success) {
      auditPayload.validationStage = 'schema_validation_failed';
      auditPayload.validationErrors = parsed.error.flatten();
      auditPayload.parsedBody = parsedBody;
      auditPayload.result = 'rejected';
      auditPayload.responseStatus = 400;
      return NextResponse.json(
        { error: 'Invalid webhook payload' },
        { status: 400 },
      );
    }

    const body = parsed.data as EasykashCallbackPayload;
    auditPayload.parsedBody = body;

    // Signature verification is mandatory in production environments.
    if (!process.env.EASYKASH_HMAC_SECRET) {
      auditPayload.validationStage = 'missing_hmac_secret';
      auditPayload.result = 'rejected';
      auditPayload.responseStatus = 503;
      console.error(
        'EasyKash webhook rejected: EASYKASH_HMAC_SECRET is not configured',
      );
      return NextResponse.json(
        { error: 'Webhook signature verification is not configured' },
        { status: 503 },
      );
    }

    if (!body.signatureHash) {
      auditPayload.validationStage = 'missing_signature';
      auditPayload.result = 'rejected';
      auditPayload.responseStatus = 400;
      return NextResponse.json(
        { error: 'Missing signatureHash' },
        { status: 400 },
      );
    }

    // -----------------------------
    // 1️⃣ Verify signature
    // -----------------------------
    const isValid = verifyCallbackSignature(body);

    if (!isValid) {
      auditPayload.validationStage = 'invalid_signature';
      auditPayload.result = 'rejected';
      auditPayload.responseStatus = 403;
      console.error('EasyKash webhook: invalid signature');
      return NextResponse.json({ error: 'Invalid signature' }, { status: 403 });
    }

    // -----------------------------
    // 2️⃣ Timestamp replay protection
    // -----------------------------
    const now = Math.floor(Date.now() / 1000);
    const timestamp = Number(body.Timestamp);

    if (!timestamp || now - timestamp > MAX_WEBHOOK_AGE) {
      auditPayload.validationStage = 'expired';
      auditPayload.result = 'rejected';
      auditPayload.responseStatus = 400;
      console.error('EasyKash webhook: timestamp expired');
      return NextResponse.json({ error: 'Expired webhook' }, { status: 400 });
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

    auditPayload.validationStage = 'accepted';
    auditPayload.result = 'processed';
    auditPayload.customerReference = customerReference;
    auditPayload.status = status;
    auditPayload.easykashRef = easykashRef;
    auditPayload.paymentMethod = PaymentMethod;
    auditPayload.amount = Amount;
    auditPayload.productCode = ProductCode;
    auditPayload.voucher = voucher;
    auditPayload.signaturePresent = Boolean(body.signatureHash);

    const normalizedStatus = (status || '').toUpperCase();
    const isSuccessfulPayment =
      normalizedStatus === 'PAID' || normalizedStatus === 'SUCCESS';

    if (isSuccessfulPayment) {
      const paymentLinkId = getPaymentLinkIdFromReference(customerReference);
      if (paymentLinkId) {
        await PaymentLink.updateOne(
          {
            _id: paymentLinkId,
            isDeleted: { $ne: true },
            status: { $ne: 'used' },
          },
          {
            $set: { status: 'used', usedAt: new Date() },
          },
        );
      }
    }

    // Idempotency key guarantees we process each callback event once.
    const eventKey = `${easykashRef}:${status}:${body.Timestamp}`;
    try {
      await WebhookEvent.create({
        provider: 'easykash',
        eventKey,
        orderReference: customerReference,
      });
    } catch {
      console.log('Webhook duplicate ignored:', eventKey);
      auditPayload.result = 'duplicate';
      auditPayload.responseStatus = 200;
      return NextResponse.json({ success: true, duplicate: true });
    }

    // Find order: Strict lookup by the exact recorded payment reference
    let order: HydratedDocument<IOrder> | null = await Order.findOne({
      'payments.easykashOrderId': customerReference,
    }).exec();

    // Fallback 1: valid MongoDB ObjectId or legacy prefixed reference
    if (!order) {
      const resolvedOrderId = getOrderIdFromReference(customerReference);
      if (resolvedOrderId) {
        order = await Order.findById(resolvedOrderId).exec();
      }
    }

    // Fallback 2: strip attempt suffix to find by orderNumber
    if (!order) {
      order = await Order.findOne({
        orderNumber: stripPaymentAttemptSuffix(customerReference),
      }).exec();
    }

    if (!order) {
      if (CUSTOM_LINK_REF_REGEX.test(customerReference || '')) {
        // Custom payment links are not attached to orders.
        auditPayload.result = 'custom_link';
        auditPayload.responseStatus = 200;
        return NextResponse.json({ success: true, customLink: true });
      }

      console.error(
        'Webhook order not found, routing to DLQ:',
        customerReference,
      );

      // Dead-Letter Queue (DLQ): Save failed hook and return 200 to prevent retries
      await WebhookEvent.updateOne(
        { provider: 'easykash', eventKey },
        {
          $set: {
            status: 'dead_letter',
            payload: body,
            errorReason: `Order not found for customerReference: ${customerReference}`,
          },
        },
      );

      return NextResponse.json({
        success: true,
        dlq: true,
        message: 'Saved to DLQ',
      });
    }

    // Find the payment record in payments array by easykashOrderId
    let payment = order.payments?.find(
      (p) => p.easykashOrderId === customerReference,
    );

    // For backward compatibility, if no payment found and this is old order without payments array
    if (!payment && !order.payments?.length) {
      // Treat as single historical payment
      const legacyPayment: IPayment = {
        paymentId: `legacy_${order._id}`,
        easykashOrderId: customerReference || order.orderNumber,
        amount: Number(Amount),
        currency: order.currency,
        status: 'pending',
        easykashResponse: undefined,
        redirectUrl: undefined,
        expiresAt: undefined,
        createdAt: order.createdAt || new Date(),
        paidAt: undefined,
      };
      order.payments = [legacyPayment];
      payment = legacyPayment;
    }

    if (
      !payment &&
      ORDER_LINK_REF_REGEX.test(customerReference || '') &&
      Array.isArray(order.payments)
    ) {
      const fallbackPayment: IPayment = {
        paymentId: `wh_${Date.now()}`,
        easykashOrderId: customerReference || order.orderNumber,
        amount: Number(Amount),
        currency: order.currency,
        status: 'pending',
        easykashResponse: undefined,
        redirectUrl: undefined,
        expiresAt: undefined,
        createdAt: new Date(),
        paidAt: undefined,
      };

      order.payments.push(fallbackPayment);
      payment = fallbackPayment;
    }

    if (!payment) {
      console.error(
        'Webhook payment not found for reference:',
        customerReference,
      );
      return NextResponse.json(
        { error: 'Payment record not found' },
        { status: 404 },
      );
    }

    // Amount verification
    const webhookAmount = Number(Amount);
    if (webhookAmount !== payment.amount) {
      console.error(
        `Amount mismatch: webhook=${webhookAmount} payment=${payment.amount}`,
      );
      return NextResponse.json({ error: 'Amount mismatch' }, { status: 400 });
    }

    // Update payment record
    payment.easykashRef = easykashRef;
    payment.easykashProductCode = ProductCode;
    payment.easykashVoucher = voucher;
    payment.paymentMethod = getPaymentMethodFromString(PaymentMethod);

    payment.easykashResponse = {
      status,
      PaymentMethod,
      Amount,
      ProductCode,
      easykashRef,
      voucher,
      BuyerEmail: body.BuyerEmail,
      BuyerMobile: body.BuyerMobile,
      BuyerName: body.BuyerName,
      Timestamp: body.Timestamp,
    };

    const easykashStatus = mapEasykashStatusToOrderStatus(status);
    payment.status = easykashStatus === 'paid' ? 'paid' : 'failed';

    if (payment.status === 'paid') {
      payment.paidAt = new Date();
    }

    // Recalculate order financial fields based on all payments
    let totalPaid = 0;
    for (const p of order.payments ?? []) {
      if (p.status === 'paid') {
        totalPaid += p.amount ?? 0;
      }
    }

    const fullAmount = order.fullAmount ?? order.totalAmount ?? 0;
    const remainingAmount = Math.max(0, fullAmount - totalPaid);

    order.paidAmount = totalPaid;
    order.remainingAmount = remainingAmount;

    // Update order status based on total paid progression.
    if (remainingAmount <= 0) {
      order.status = 'paid';
    } else if (totalPaid > 0) {
      order.status = 'processing';
    } else if (order.status !== 'paid') {
      order.status = 'processing';
    }

    // Also set legacy fields for backward compatibility
    order.easykashRef = easykashRef;
    order.easykashProductCode = ProductCode;
    order.easykashVoucher = voucher;
    order.paymentMethod = getPaymentMethodFromString(PaymentMethod);

    await order.save();

    // Fire background tasks if fully paid
    if (order.status === 'paid') {
      const item = order.items?.[0];

      if (item) {
        const sourceBaseUrls: Record<string, string> = {
          manasik: process.env.MANASIK_URL || 'https://www.manasik.net',
          ghadaq: process.env.GHADAQ_URL || 'https://www.ghadaqplus.com',
        };

        const baseUrl =
          sourceBaseUrls[order.source || 'manasik'] || sourceBaseUrls.manasik;

        trackPurchase({
          productId: String(item.productId),
          productName: item.productName?.en || item.productName?.ar || '',
          value: order.fullAmount ?? 0,
          currency: order.currency || 'SAR',
          numItems: item.quantity || 1,
          orderId: order.orderNumber,
          sourceUrl: `${baseUrl}/payment/status`,
          userData: {
            em: order.billingData?.email,
            ph: order.billingData?.phone,
            fn: order.billingData?.fullName?.split(' ')[0],
            ln:
              order.billingData?.fullName?.split(' ').slice(1).join(' ') ||
              order.billingData?.fullName?.split(' ')[0],
            country: order.billingData?.country || order.countryCode,
            external_id: order._id.toString(),
          },
        }).catch(() => {});
      }

      sendOrderConfirmationEmail(order.toObject() as IOrder).catch((e) => {
        captureException(e, {
          service: 'EmailService',
          operation: 'sendOrderConfirmationEmail',
          severity: 'high',
          metadata: { orderId: order._id.toString() },
        });
      });
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    captureException(error, {
      service: 'Webhook',
      operation: 'POST',
      severity: 'critical',
    });

    auditPayload.result = 'error';
    auditPayload.errorMessage =
      error instanceof Error ? error.message : String(error);
    auditPayload.responseStatus = 500;

    return NextResponse.json(
      { success: false, error: 'Webhook processing failed' },
      { status: 500 },
    );
  } finally {
    try {
      await TerminalLog.create({
        ts: new Date().toISOString(),
        level: 'info',
        event: 'webhook.call',
        source: 'request',
        message: 'EasyKash webhook request audit',
        payload: auditPayload,
      });
    } catch {
      // Best-effort audit persistence only.
    }
  }
}
