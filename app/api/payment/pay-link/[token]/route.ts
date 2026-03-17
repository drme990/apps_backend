import { createHash } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import PaymentLink from '@/lib/models/PaymentLink';
import Order from '@/lib/models/Order';
import Product from '@/lib/models/Product';

const OBJECT_ID_REGEX = /^[a-f\d]{24}$/i;

async function resolveProductSlug(order: {
  items?: Array<{ productSlug?: string; productId?: string }>;
}) {
  const primaryItem = order.items?.[0];
  if (!primaryItem) return null;

  if (primaryItem.productSlug) return primaryItem.productSlug;

  if (!primaryItem.productId || !OBJECT_ID_REGEX.test(primaryItem.productId)) {
    return null;
  }

  const product = await Product.findById(primaryItem.productId, {
    slug: 1,
  }).lean();
  return product?.slug || null;
}

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

    const productSlug = await resolveProductSlug(order);
    if (!productSlug) {
      return NextResponse.json(
        { success: false, error: 'Product slug could not be resolved' },
        { status: 400 },
      );
    }

    const firstItem = order.items?.[0];

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

    return NextResponse.json({
      success: true,
      data: {
        source: paymentLink.source,
        orderNumber: order.orderNumber,
        productSlug,
        quantity: firstItem?.quantity || 1,
        sizeIndex: order.sizeIndex ?? 0,
        billingData: {
          fullName: order.billingData.fullName,
          email: order.billingData.email,
          phone: order.billingData.phone,
          country: order.billingData.country,
        },
        reservationData: Array.isArray(order.reservationData)
          ? order.reservationData.map((entry) => ({
              key: entry.key,
              value: entry.value,
            }))
          : [],
        couponCode: order.couponCode || null,
        referralId: order.referralId || null,
        paymentOption: 'custom' as const,
        customAmount: requestedAmount,
        currency: order.currency,
        remainingAmount,
        amountRequested: requestedAmount,
        isCustomAmount: !!paymentLink.isCustomAmount,
        expiresAt: paymentLink.expiresAt,
      },
    });
  } catch (error) {
    console.error('Error resolving pay link:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to resolve pay link' },
      { status: 500 },
    );
  }
}
