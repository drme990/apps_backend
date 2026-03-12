import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import Order, { type IOrder } from '@/lib/models/Order';
import {
  verifyCallbackSignature,
  type EasykashCallbackPayload,
} from '@/lib/services/easykash';
import { trackPurchase } from '@/lib/services/fb-capi';
import { sendOrderConfirmationEmail } from '@/lib/services/email';

const MAX_WEBHOOK_AGE = 7 * 60; // 7 minutes

export async function POST(request: NextRequest) {
  try {
    await connectDB();

    const body: EasykashCallbackPayload = await request.json();

    // -----------------------------
    // 1️⃣ Verify signature
    // -----------------------------
    if (process.env.EASYKASH_HMAC_SECRET) {
      const isValid = verifyCallbackSignature(body);

      if (!isValid) {
        console.error('EasyKash webhook: invalid signature');
        return NextResponse.json(
          { error: 'Invalid signature' },
          { status: 403 },
        );
      }
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

    if (!customerReference) {
      return NextResponse.json(
        { error: 'Missing customerReference' },
        { status: 400 },
      );
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
    // 4️⃣ Idempotency protection
    // -----------------------------
    if (order.easykashRef && order.easykashRef === easykashRef) {
      console.log('Webhook duplicate ignored:', easykashRef);
      return NextResponse.json({ success: true });
    }

    // -----------------------------
    // 5️⃣ Amount verification
    // -----------------------------
    const webhookAmount = Number(Amount);

    if (webhookAmount !== order.totalAmount) {
      console.error(
        `Amount mismatch: webhook=${webhookAmount} order=${order.totalAmount}`,
      );
      return NextResponse.json({ error: 'Amount mismatch' }, { status: 400 });
    }

    // -----------------------------
    // 6️⃣ Prevent already-paid reprocessing
    // -----------------------------
    if (order.status === 'paid') {
      console.log('Webhook ignored: order already paid');
      return NextResponse.json({ success: true });
    }

    // -----------------------------
    // 7️⃣ Update order
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

    // status mapping
    if (status === 'PAID') order.status = 'paid';
    else if (status === 'FAILED' || status === 'EXPIRED')
      order.status = 'failed';
    else if (status === 'REFUNDED') order.status = 'refunded';
    else order.status = 'processing';

    await order.save();

    // -----------------------------
    // 8️⃣ Fire background tasks
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
