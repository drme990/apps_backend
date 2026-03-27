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
import WebhookEvent from '@/lib/models/WebhookEvent';
import PaymentLink from '@/lib/models/PaymentLink';
import { parseJsonBody } from '@/lib/validation/http';
import { webhookSchema } from '@/lib/validation/schemas';

const MAX_WEBHOOK_AGE = 7 * 60; // 7 minutes
const OBJECT_ID_REGEX = /^[a-f\d]{24}$/i;
const ORDER_REF_REGEX = /^ord_([a-f\d]{24})_[a-f\d]{24}_\d+$/i;
const ORDER_LINK_REF_REGEX = /^ord_([a-f\d]{24})_([a-f\d]{24})_\d+$/i;
const CUSTOM_LINK_REF_REGEX = /^custom-([a-f\d]{24})$/i;

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
  try {
    await connectDB();

    const parsed = await parseJsonBody(request, webhookSchema);
    if (!parsed.success) return parsed.response;
    const body = parsed.data as EasykashCallbackPayload;

    // Signature verification is mandatory in production environments.
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
      console.error('EasyKash webhook: invalid signature');
      return NextResponse.json({ error: 'Invalid signature' }, { status: 403 });
    }

    // -----------------------------
    // 2️⃣ Timestamp replay protection
    // -----------------------------
    const now = Math.floor(Date.now() / 1000);
    const timestamp = Number(body.Timestamp);

    if (!timestamp || now - timestamp > MAX_WEBHOOK_AGE) {
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
      return NextResponse.json({ success: true, duplicate: true });
    }

    // Find order: customerReference can be order _id or easykashOrderId (with -PX suffix)
    let order: HydratedDocument<IOrder> | null = null;

    // First, try to find by _id if customerReference is a valid MongoDB ObjectId
    const resolvedOrderId = getOrderIdFromReference(customerReference);
    if (resolvedOrderId) {
      order = await Order.findById(resolvedOrderId).exec();
    }

    // If not found by _id, try to find by orderNumber (for backward compatibility)
    if (!order) {
      order = await Order.findOne({
        orderNumber: customerReference.split('-P')[0],
      });
    }

    if (!order) {
      if (CUSTOM_LINK_REF_REGEX.test(customerReference || '')) {
        // Custom payment links are not attached to orders.
        return NextResponse.json({ success: true, customLink: true });
      }

      console.error('Webhook order not found:', customerReference);
      return NextResponse.json({ error: 'Order not found' }, { status: 404 });
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
        createdAt: order.createdAt,
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

    order.paidAmount = totalPaid;
    order.remainingAmount = Math.max(0, (order.fullAmount ?? 0) - totalPaid);

    // Update order status based on remaining amount
    if (order.remainingAmount <= 0) {
      order.status = 'paid';
    } else {
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
          productId: item.productId,
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

      sendOrderConfirmationEmail(order.toObject() as IOrder).catch(() => {});
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('EasyKash webhook error:', error);

    return NextResponse.json(
      { success: false, error: 'Webhook processing failed' },
      { status: 500 },
    );
  }
}
