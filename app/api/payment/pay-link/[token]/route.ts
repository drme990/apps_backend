import { createHash } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import PaymentLink from '@/lib/models/PaymentLink';
import Order from '@/lib/models/Order';
import { createPayment } from '@/lib/services/easykash';
import { EASYKASH_CURRENCIES } from '@/lib/services/payment-link';
import { convertCurrency } from '@/lib/services/currency';

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
    const paymentLink = await PaymentLink.findOne({
      $or: [{ publicToken: token }, { tokenHash }],
    }).lean();

    if (!paymentLink || paymentLink.kind !== 'order' || paymentLink.isDeleted) {
      return NextResponse.json(
        { success: false, error: 'Pay link not found' },
        { status: 404 },
      );
    }

    if (paymentLink.status === 'used') {
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

    const openResult = await PaymentLink.updateOne(
      {
        _id: paymentLink._id,
        isDeleted: { $ne: true },
        status: { $in: ['unused', 'opened'] },
      },
      {
        $set: { status: 'opened', openedAt: new Date() },
      },
    );

    if (!openResult.modifiedCount) {
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
        const converted = await convertCurrency(
          requestedAmount,
          paymentCurrency,
          'EGP',
        );
        easykashAmount = Math.ceil(converted);
        paymentCurrency = 'EGP';
      }

      if (easykashAmount <= 1) {
        await PaymentLink.updateOne(
          { _id: paymentLink._id, status: 'opened' },
          { $set: { status: 'unused', openedAt: null } },
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
        {
          _id: order._id,
          status: { $nin: ['partially-paid', 'paid', 'completed'] },
        },
        { $set: { status: 'processing' } },
      );

      return NextResponse.redirect(easykashResponse.redirectUrl, {
        status: 302,
      });
    } catch (gatewayError) {
      await PaymentLink.updateOne(
        { _id: paymentLink._id, status: 'opened' },
        { $set: { status: 'unused', openedAt: null } },
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
