import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import Order, { type IOrder } from '@/lib/models/Order';
import {
  verifyCallbackSignature,
  type EasykashCallbackPayload,
} from '@/lib/services/easykash';
import { trackPurchase } from '@/lib/services/fb-capi';
import { sendOrderConfirmationEmail } from '@/lib/services/email';

export async function POST(request: NextRequest) {
  try {
    await connectDB();
    const body: EasykashCallbackPayload = await request.json();

    if (process.env.EASYKASH_HMAC_SECRET) {
      const isValid = verifyCallbackSignature(body);
      if (!isValid) {
        console.error('Invalid signature in EasyKash webhook callback');
        return NextResponse.json(
          { success: false, error: 'Invalid signature' },
          { status: 403 },
        );
      }
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
      console.error('No customerReference in EasyKash callback');
      return NextResponse.json(
        { success: false, error: 'No customerReference' },
        { status: 400 },
      );
    }

    // New orders use _id as customerReference; legacy orders used orderNumber.
    // Try _id lookup first, fall back to orderNumber for backward compatibility.
    const order =
      (await Order.findById(customerReference).exec()) ??
      (await Order.findOne({ orderNumber: customerReference }));

    if (!order) {
      console.error(
        `Order not found for customerReference: ${customerReference}`,
      );
      return NextResponse.json(
        { success: false, error: 'Order not found' },
        { status: 404 },
      );
    }

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
    if (
      methodLower.includes('credit') ||
      methodLower.includes('debit') ||
      methodLower.includes('card')
    ) {
      order.paymentMethod = 'card';
    } else if (methodLower.includes('wallet')) {
      order.paymentMethod = 'wallet';
    } else if (methodLower.includes('fawry')) {
      order.paymentMethod = 'fawry';
    } else if (methodLower.includes('meeza')) {
      order.paymentMethod = 'meeza';
    } else if (methodLower.includes('valu')) {
      order.paymentMethod = 'valu';
    } else {
      order.paymentMethod = 'other';
    }

    if (status === 'PAID') {
      order.status = 'paid';
    } else if (status === 'FAILED' || status === 'EXPIRED') {
      order.status = 'failed';
    } else if (status === 'REFUNDED') {
      order.status = 'refunded';
    } else if (status === 'NEW' || status === 'PENDING') {
      order.status = 'processing';
    } else {
      order.status = 'processing';
    }

    await order.save();

    // FB CAPI: Purchase
    if (order.status === 'paid' && order.items?.length > 0) {
      const item = order.items[0];
      const sourceBaseUrls: Record<string, string> = {
        manasik: process.env.MANASIK_URL || 'https://www.manasik.net',
        ghadaq: process.env.GHADAQ_URL || 'https://www.ghadaqplus.com',
      };
      const baseUrl =
        sourceBaseUrls[order.source || 'manasik'] || sourceBaseUrls.manasik;

      trackPurchase({
        productId: item.productId,
        productName: item.productName?.en || item.productName?.ar || '',
        value: order.totalAmount ?? order.paidAmount ?? 0,
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

    // Send order confirmation email for paid orders (fire-and-forget)
    if (order.status === 'paid') {
      sendOrderConfirmationEmail(order.toObject() as IOrder).catch(() => {});
    }

    console.log(
      `EasyKash webhook: Order ${order.orderNumber} → ${order.status} (ref: ${easykashRef})`,
    );
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error processing EasyKash webhook:', error);
    return NextResponse.json(
      { success: false, error: 'Webhook processing failed' },
      { status: 500 },
    );
  }
}
