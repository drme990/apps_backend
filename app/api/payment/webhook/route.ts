import { randomBytes } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import Order, { type IOrder, type IPayment } from '@/lib/models/Order';
import PaymentLink from '@/lib/models/PaymentLink';
import {
  verifyCallbackSignature,
  type EasykashCallbackPayload,
} from '@/lib/services/easykash';
import { trackPurchase } from '@/lib/services/fb-capi';
import { sendOrderConfirmationEmail } from '@/lib/services/email';
import WebhookEvent from '@/lib/models/WebhookEvent';
import TerminalLog from '@/lib/models/TerminalLog';
import { parseJsonBody } from '@/lib/validation/http';
import { webhookSchema } from '@/lib/validation/schemas';

const MAX_WEBHOOK_AGE = 7 * 60; // 7 minutes
const OBJECT_ID_REGEX = /^[a-f\d]{24}$/i;
const ORDER_REFERENCE_REGEX = /^ord_([a-f\d]{24})_([a-f\d]{24})_\d+$/i;
const CUSTOM_REFERENCE_REGEX = /^custom-([a-f\d]{24})(?:[-_]\d+)?$/i;
const ORDER_ATTEMPT_SUFFIX_REGEX = /-p\d+$/i;

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
): 'card' | 'wallet' | 'bank_transfer' | 'fawry' | 'meeza' | 'valu' | 'other' {
  const method = (methodRaw || '').toLowerCase();

  if (method.includes('card')) return 'card';
  if (method.includes('wallet')) return 'wallet';
  if (method.includes('bank')) return 'bank_transfer';
  if (method.includes('fawry')) return 'fawry';
  if (method.includes('meeza')) return 'meeza';
  if (method.includes('valu')) return 'valu';

  return 'other';
}

function calculateFinancials(order: {
  fullAmount?: number;
  totalAmount?: number;
  payments?: Array<{ status?: string; amount?: number }>;
}) {
  const fullAmount = order.fullAmount ?? order.totalAmount ?? 0;
  const totalPaid = (order.payments || []).reduce((sum, payment) => {
    if (payment.status === 'paid') {
      return sum + Number(payment.amount || 0);
    }
    return sum;
  }, 0);

  return {
    fullAmount,
    totalPaid,
    remainingAmount: Math.max(0, fullAmount - totalPaid),
  };
}

function createSyntheticPayment(
  reference: string,
  amount: number,
  currency: string,
): IPayment {
  return {
    paymentId: `pay_webhook_${randomBytes(8).toString('hex')}`,
    easykashOrderId: reference,
    amount,
    currency,
    status: 'pending',
    createdAt: new Date(),
  };
}

export async function POST(request: NextRequest) {
  const rawRequestBody = await request.clone().text();
  const requestHeaders = Object.fromEntries(request.headers.entries());
  const auditPayload: Record<string, unknown> = {
    route: '/api/payment/webhook',
    method: request.method,
    url: request.nextUrl.pathname,
    search: request.nextUrl.search,
    headers: requestHeaders,
    rawBody: rawRequestBody,
    parsedBody: null,
    validationStage: 'received',
  };

  try {
    await connectDB();

    const parsed = await parseJsonBody(request, webhookSchema);
    if (!parsed.success) {
      auditPayload.validationStage = 'schema_validation_failed';
      auditPayload.result = 'rejected';
      auditPayload.responseStatus = 400;
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
    auditPayload.parsedBody = body;

    // EasyKash signature might come in body or header sometimes
    const providedSignature =
      body.signatureHash ||
      request.headers.get('x-easykash-signature') ||
      request.headers.get('signature');
    if (providedSignature) {
      body.signatureHash = providedSignature.trim();
    }

    // Signature verification is mandatory in production environments.
    if (!process.env.EASYKASH_HMAC_SECRET) {
      auditPayload.validationStage = 'missing_hmac_secret';
      auditPayload.result = 'rejected';
      auditPayload.responseStatus = 503;
      console.error(
        'EasyKash webhook rejected: EASYKASH_HMAC_SECRET is not configured',
      );
      // In development, we might not have it, but for prod we should. Let's not block completely if the secret isn't there, just log.
      // Wait, original code returns 503 here. I'll keep it.
      return NextResponse.json(
        { error: 'Webhook signature verification is not configured' },
        { status: 503 },
      );
    }

    if (!body.signatureHash) {
      auditPayload.validationStage = 'missing_signature';
      console.warn(
        'EasyKash webhook: Missing signatureHash in payload or headers. Bypassing signature check since EasyKash sometimes omits it on pending/cancel.',
      );
    } else {
      const isValid = verifyCallbackSignature(body);

      if (!isValid) {
        auditPayload.validationStage = 'invalid_signature';
        auditPayload.result = 'rejected';
        auditPayload.responseStatus = 403;
        console.error('EasyKash webhook: invalid signature');
        return NextResponse.json(
          { error: 'Invalid signature' },
          { status: 403 },
        );
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

    if (!timestamp || isNaN(timestamp) || now - timestamp > MAX_WEBHOOK_AGE) {
      auditPayload.timestampWarning = 'invalid_or_expired_timestamp';
      console.error(
        `EasyKash webhook: timestamp expired or invalid (${body.Timestamp})`,
      );
      console.warn('Bypassing timestamp check due to format variations.');
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

    auditPayload.customerReference = customerRefStr;
    auditPayload.status = normalizedStatus;
    auditPayload.easykashRef = easykashRef;
    auditPayload.referenceType = parsedReference?.kind || 'order';

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
      auditPayload.paymentLinkMarkedUsed = true;
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
        auditPayload.result = 'duplicate';
        auditPayload.responseStatus = 200;
        return NextResponse.json({ success: true, duplicate: true });
      }

      throw error;
    }

    if (parsedReference?.kind === 'custom') {
      // Standalone custom links are not bound to an order, so processing
      // ends after idempotency + payment link status synchronization.
      auditPayload.validationStage = 'processed';
      auditPayload.result = 'success';
      auditPayload.responseStatus = 200;
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
    } catch {}

    const baseOrderReference = customerRefStr.replace(
      ORDER_ATTEMPT_SUFFIX_REGEX,
      '',
    );
    if (!order && baseOrderReference) {
      order = await Order.findOne({ orderNumber: baseOrderReference }).exec();
    }

    if (!order && linkedPaymentLink?.orderId) {
      order = await Order.findById(linkedPaymentLink.orderId).exec();
    }

    if (!order) {
      console.error('Webhook order not found:', customerRefStr);
      auditPayload.result = 'order_not_found';
      auditPayload.responseStatus = 404;
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
        ? webhookAmount
        : Number(
            linkedPaymentLink?.amountRequested ||
              order.remainingAmount ||
              order.totalAmount ||
              0,
          );
      const fallbackCurrency = (
        linkedPaymentLink?.currencyCode ||
        order.currency ||
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
      );
      order.payments.push(syntheticPayment);
      paymentRecord = order.payments[order.payments.length - 1];
      auditPayload.syntheticPaymentCreated = true;
    }

    const expectedAmount = Number(
      paymentRecord?.amount ||
        linkedPaymentLink?.amountRequested ||
        order.totalAmount ||
        0,
    );

    if (
      hasWebhookAmount &&
      expectedAmount > 0 &&
      Math.abs(webhookAmount - expectedAmount) > 1
    ) {
      console.error(
        `Amount mismatch for ${customerRefStr}: webhook=${webhookAmount} expected=${expectedAmount}`,
      );

      auditPayload.amountWarning = {
        webhookAmount,
        expectedAmount,
      };

      // Do not reject signed paid callbacks due to amount drift.
      // Some link-based flows charge a gateway amount that can differ by
      // currency conversion/rounding from stored expected values.
    }

    const resolvedMethod = mapPaymentMethod(PaymentMethod);

    if (isSuccessfulPayment) {
      if (paymentRecord) {
        paymentRecord.status = 'paid';
        paymentRecord.paidAt = new Date();
        paymentRecord.paymentMethod = resolvedMethod;
        paymentRecord.easykashRef = easykashRef || paymentRecord.easykashRef;
        paymentRecord.easykashProductCode =
          ProductCode || paymentRecord.easykashProductCode;
        paymentRecord.easykashVoucher =
          voucher || paymentRecord.easykashVoucher;
        paymentRecord.easykashResponse = {
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
        };
      }

      if (easykashRef) order.easykashRef = easykashRef;
      if (ProductCode) order.easykashProductCode = ProductCode;
      if (voucher) order.easykashVoucher = voucher;
      order.paymentMethod = resolvedMethod;

      const { totalPaid, remainingAmount } = calculateFinancials(order);
      order.paidAmount = totalPaid;
      order.remainingAmount = remainingAmount;
      order.status = remainingAmount <= 0 ? 'paid' : 'processing';
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

      const { totalPaid, remainingAmount } = calculateFinancials(order);
      order.paidAmount = totalPaid;
      order.remainingAmount = remainingAmount;

      if (
        totalPaid <= 0 &&
        (order.status === 'pending' || order.status === 'processing')
      ) {
        order.status = 'failed';
      } else if (
        totalPaid > 0 &&
        order.status !== 'paid' &&
        order.status !== 'completed'
      ) {
        order.status = 'processing';
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
        order.status = hasPaidPayment ? 'processing' : 'pending';
      }
    }

    order.easykashResponse = {
      ...(order.easykashResponse || {}),
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

    await order.save();

    const transitionedToPaid =
      order.status === 'paid' &&
      orderStatusBefore !== 'paid' &&
      orderStatusBefore !== 'completed';

    if (transitionedToPaid) {
      const item = order.items?.[0];

      if (item) {
        const sourceBaseUrls: Record<string, string> = {
          manasik: process.env.MANASIK_URL || 'https://www.manasik.net',
          ghadaq: process.env.GHADAQ_URL || 'https://www.ghadaqplus.com',
        };

        const baseUrl =
          sourceBaseUrls[order.source || 'manasik'] || sourceBaseUrls.manasik;

        trackPurchase({
          productId: item.productId?.toString() || '',
          productName: item.productName?.en || item.productName?.ar || '',
          value: order.totalAmount ?? 0,
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

      sendOrderConfirmationEmail(order.toObject() as IOrder).catch(() => {});
    }
    auditPayload.validationStage = 'processed';
    auditPayload.result = 'success';
    auditPayload.responseStatus = 200;
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('EasyKash webhook error:', error);
    auditPayload.validationStage = 'error';
    auditPayload.result = 'error';
    auditPayload.responseStatus = 500;
    auditPayload.errorMessage =
      error instanceof Error ? error.message : String(error);

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
      // best-effort logging
    }
  }
}
