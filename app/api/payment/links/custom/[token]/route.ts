import { createHash } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import PaymentLink from '@/lib/models/PaymentLink';
import {
  createPayment,
  getEasykashCashExpiryHours,
} from '@/lib/services/easykash';
import { convertCurrency } from '@/lib/services/currency';
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
    const paymentLink = await PaymentLink.findOne({
      $or: [{ publicToken: token }, { tokenHash }],
    }).lean();

    if (
      !paymentLink ||
      paymentLink.kind !== 'custom' ||
      paymentLink.isDeleted
    ) {
      return NextResponse.json(
        { success: false, error: 'Custom pay link not found' },
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
      let easykashAmount = Math.ceil(paymentLink.amountRequested);
      let paymentCurrency = (paymentLink.currencyCode || 'EGP').toUpperCase();

      if (
        !EASYKASH_CURRENCIES.includes(
          paymentCurrency as (typeof EASYKASH_CURRENCIES)[number],
        )
      ) {
        const converted = await convertCurrency(
          paymentLink.amountRequested,
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

      const customerReference = `custom-${paymentLink._id}-${Date.now()}`;
      const cashExpiryHours = getEasykashCashExpiryHours();

      const easykashResponse = await createPayment({
        amount: easykashAmount,
        currency: paymentCurrency,
        name: 'Payment Link Customer',
        email: 'payment-link@manasik.local',
        mobile: '+201000000000',
        cashExpiry: cashExpiryHours,
        redirectUrl: `${baseUrl}/payment/status?status=pending&customPayment=1&amount=${encodeURIComponent(String(paymentLink.amountRequested))}&currency=${encodeURIComponent(paymentLink.currencyCode)}&gatewayAmount=${encodeURIComponent(String(easykashAmount))}&gatewayCurrency=${encodeURIComponent(paymentCurrency)}`,
        customerReference,
      });

      return NextResponse.redirect(easykashResponse.redirectUrl, {
        status: 302,
      });
    } catch (gatewayError) {
      await PaymentLink.updateOne(
        { _id: paymentLink._id, status: 'opened' },
        { $set: { status: 'unused', openedAt: null } },
      );

      console.error(
        'Error creating payment for custom pay link:',
        gatewayError,
      );
      return NextResponse.json(
        { success: false, error: 'Failed to initialize payment' },
        { status: 502 },
      );
    }
  } catch (error) {
    console.error('Error resolving custom pay link:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to resolve custom pay link' },
      { status: 500 },
    );
  }
}
