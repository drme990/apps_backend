import { createHash } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import PaymentLink from '@/lib/models/PaymentLink';
import { createPayment } from '@/lib/services/easykash';

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

    const easykashResponse = await createPayment({
      amount: Math.ceil(paymentLink.amountRequested),
      currency: paymentLink.currencyCode,
      name: 'Payment Link Customer',
      email: 'payment-link@manasik.local',
      mobile: '+201000000000',
      redirectUrl: `${baseUrl}/payment/status?status=pending&customPayment=1&amount=${encodeURIComponent(String(paymentLink.amountRequested))}&currency=${encodeURIComponent(paymentLink.currencyCode)}`,
      customerReference: `custom-${paymentLink._id}`,
    });

    return NextResponse.redirect(easykashResponse.redirectUrl, { status: 302 });
  } catch (error) {
    console.error('Error resolving custom pay link:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to resolve custom pay link' },
      { status: 500 },
    );
  }
}
