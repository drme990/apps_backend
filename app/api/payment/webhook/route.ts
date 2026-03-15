import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import Order, { type IOrder } from '@/lib/models/Order';
import {
  verifyCallbackSignature,
  type EasykashCallbackPayload,
  mapEasykashStatusToOrderStatus,
} from '@/lib/services/easykash';
import { trackPurchase } from '@/lib/services/fb-capi';
import { sendOrderConfirmationEmail } from '@/lib/services/email';
import WebhookEvent from '@/lib/models/WebhookEvent';
import { parseJsonBody } from '@/lib/validation/http';
import { webhookSchema } from '@/lib/validation/schemas';

const MAX_WEBHOOK_AGE = 7 * 60; // 7 minutes

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

    // -----------------------------
    // 3️⃣ Find order
    // -----------------------------
    const order =
      (await Order.findById(customerReference).exec()) ??
      (await Order.findOne({ orderNumber: customerReference }));

    if (!order) {
      console.error('Webhook order not found:', customerReference);
      return NextResponse.json({ error: 'Order not found' }, { status: 404 });
    }

    // -----------------------------
    // 4️⃣ Amount verification
    // -----------------------------
    const webhookAmount = Number(Amount);

    if (webhookAmount !== order.totalAmount) {
      console.error(
        `Amount mismatch: webhook=${webhookAmount} order=${order.totalAmount}`,
      );
      return NextResponse.json({ error: 'Amount mismatch' }, { status: 400 });
    }

    // -----------------------------
    // 5️⃣ Prevent already-paid reprocessing
    // -----------------------------
    if (order.status === 'paid') {
      console.log('Webhook ignored: order already paid');
      return NextResponse.json({ success: true });
    }

    // -----------------------------
    // 6️⃣ Update order
    // -----------------------------
    order.easykashRef = easykashRef;
    order.easykashProductCode = ProductCode;
    order.easykashVoucher = voucher;

    order.easykashResponse = {
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

    const methodLower = (PaymentMethod || '').toLowerCase();

    if (methodLower.includes('card')) order.paymentMethod = 'card';
    else if (methodLower.includes('wallet')) order.paymentMethod = 'wallet';
    else if (methodLower.includes('fawry')) order.paymentMethod = 'fawry';
    else if (methodLower.includes('meeza')) order.paymentMethod = 'meeza';
    else if (methodLower.includes('valu')) order.paymentMethod = 'valu';
    else order.paymentMethod = 'other';

    order.status = mapEasykashStatusToOrderStatus(status);

    await order.save();

    // -----------------------------
    // 7️⃣ Fire background tasks
    // -----------------------------
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
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('EasyKash webhook error:', error);

    return NextResponse.json(
      { success: false, error: 'Webhook processing failed' },
      { status: 500 },
    );
  }
}
