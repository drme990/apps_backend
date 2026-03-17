import { createHash } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import PaymentLink from '@/lib/models/PaymentLink';
import Order from '@/lib/models/Order';
import { createPayment } from '@/lib/services/easykash';
import Product from '@/lib/models/Product';
import { EASYKASH_CURRENCIES } from '@/lib/services/payment-link';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  try {
    await connectDB();
    const { token } = await params;

    if (!token || token.length < 16) {
      return NextResponse.json(
        { success: false, error: 'Invalid pay link token' },
        { status: 400 },
      );
    }

    const tokenHash = createHash('sha256').update(token).digest('hex');
    const paymentLink = await PaymentLink.findOne({ tokenHash }).lean();

    if (!paymentLink || paymentLink.kind !== 'order' || paymentLink.isDeleted) {
      return NextResponse.json(
        { success: false, error: 'Pay link not found' },
        { status: 404 },
      );
    }

    if (paymentLink.usedAt) {
      return NextResponse.json(
        { success: false, error: 'Pay link has already been used' },
        { status: 410 },
      );
    }

    if (new Date(paymentLink.expiresAt).getTime() <= Date.now()) {
      return NextResponse.json(
        { success: false, error: 'Pay link has expired' },
        { status: 410 },
      );
    }

    const order = await Order.findById(paymentLink.orderId).lean();
    if (!order) {
      return NextResponse.json(
        { success: false, error: 'Order not found' },
        { status: 404 },
      );
    }

    const remainingAmount = order.remainingAmount || 0;
    if (remainingAmount <= 0) {
      return NextResponse.json(
        { success: false, error: 'Order has no remaining amount' },
        { status: 400 },
      );
    }

    const requestedAmount = paymentLink.amountRequested || remainingAmount;
    if (requestedAmount > remainingAmount) {
      return NextResponse.json(
        {
          success: false,
          error:
            'Pay link amount is higher than the current remaining amount. Please request a new link.',
        },
        { status: 409 },
      );
    }

    if (!process.env.EASYKASH_API_KEY) {
      return NextResponse.json(
        { success: false, error: 'Payment gateway is not configured' },
        { status: 503 },
      );
    }

    const sourceBaseUrls: Record<string, string> = {
      manasik: process.env.MANASIK_URL || 'https://www.manasik.net',
      ghadaq: process.env.GHADAQ_URL || 'https://www.ghadaqplus.com',
    };
    const source = paymentLink.source === 'ghadaq' ? 'ghadaq' : 'manasik';
    const baseUrl = sourceBaseUrls[source];

    const consumeResult = await PaymentLink.updateOne(
      {
        _id: paymentLink._id,
        isDeleted: { $ne: true },
        usedAt: null,
      },
      {
        $set: { usedAt: new Date() },
      },
    );

    if (!consumeResult.modifiedCount) {
      return NextResponse.json(
        { success: false, error: 'Pay link has already been used' },
        { status: 410 },
      );
    }

    try {
      let easykashAmount = Math.ceil(requestedAmount);
      let paymentCurrency = (paymentLink.currencyCode || order.currency)
        .toUpperCase()
        .trim();

      if (
        !EASYKASH_CURRENCIES.includes(
          paymentCurrency as (typeof EASYKASH_CURRENCIES)[number],
        )
      ) {
        const firstItem = order.items?.[0];
        if (!firstItem?.productId) {
          await PaymentLink.updateOne(
            { _id: paymentLink._id, usedAt: { $ne: null } },
            { $set: { usedAt: null } },
          );

          return NextResponse.json(
            {
              success: false,
              error:
                'This pay link currency is not supported by the payment gateway and cannot be converted automatically.',
            },
            { status: 400 },
          );
        }

        const product = await Product.findOne({
          _id: firstItem.productId,
          isDeleted: { $ne: true },
        }).lean();
        const sizeIndex =
          order.sizeIndex !== undefined &&
          order.sizeIndex !== null &&
          order.sizeIndex >= 0
            ? order.sizeIndex
            : 0;
        const selectedSize =
          product?.sizes?.[sizeIndex] || product?.sizes?.[0] || null;
        const egpPrice = selectedSize?.prices?.find(
          (p: { currencyCode: string; amount: number }) =>
            p.currencyCode === 'EGP',
        )?.amount;

        if (!egpPrice || egpPrice <= 0) {
          await PaymentLink.updateOne(
            { _id: paymentLink._id, usedAt: { $ne: null } },
            { $set: { usedAt: null } },
          );

          return NextResponse.json(
            {
              success: false,
              error:
                'This pay link currency is not supported by the payment gateway and EGP fallback is unavailable for this product.',
            },
            { status: 400 },
          );
        }

        const quantity = firstItem.quantity || 1;
        const egpFullAmount = egpPrice * quantity;
        const fullAmount =
          order.fullAmount ||
          (order.paidAmount || 0) + (order.remainingAmount || 0) ||
          order.totalAmount;
        const outstandingRatio =
          fullAmount > 0 ? remainingAmount / fullAmount : 1;
        const requestedRatio =
          remainingAmount > 0 ? requestedAmount / remainingAmount : 1;

        easykashAmount = Math.ceil(
          egpFullAmount * outstandingRatio * requestedRatio,
        );
        paymentCurrency = 'EGP';
      }

      if (easykashAmount <= 1) {
        await PaymentLink.updateOne(
          { _id: paymentLink._id, usedAt: { $ne: null } },
          { $set: { usedAt: null } },
        );

        return NextResponse.json(
          {
            success: false,
            error:
              'Payment amount is too low. Minimum accepted by the payment gateway is 2.',
          },
          { status: 400 },
        );
      }

      const customerReference = `ord_${String(order._id)}_${String(paymentLink._id)}_${Date.now()}`;

      const easykashResponse = await createPayment({
        amount: easykashAmount,
        currency: paymentCurrency,
        name: 'Payment Link Customer',
        email: 'payment-link@manasik.local',
        mobile: '+201000000000',
        redirectUrl: `${baseUrl}/payment/status?orderNumber=${encodeURIComponent(order.orderNumber)}&customerReference=${encodeURIComponent(customerReference)}`,
        customerReference,
      });

      await Order.updateOne(
        { _id: order._id, status: { $nin: ['paid', 'completed'] } },
        { $set: { status: 'processing' } },
      );

      return NextResponse.redirect(easykashResponse.redirectUrl, {
        status: 302,
      });
    } catch (gatewayError) {
      await PaymentLink.updateOne(
        { _id: paymentLink._id, usedAt: { $ne: null } },
        { $set: { usedAt: null } },
      );

      console.error('Error creating payment for order pay link:', gatewayError);
      const details =
        gatewayError instanceof Error
          ? gatewayError.message.slice(0, 240)
          : 'gateway initialization failed';
      return NextResponse.json(
        {
          success: false,
          error: `Failed to initialize payment (${details})`,
        },
        { status: 502 },
      );
    }
  } catch (error) {
    console.error('Error resolving pay link:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to resolve pay link' },
      { status: 500 },
    );
  }
}
