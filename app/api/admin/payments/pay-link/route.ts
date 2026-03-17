import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAuth } from '@/lib/auth';
import Order from '@/lib/models/Order';
import {
  createPayLinkForOrder,
  createStandaloneCustomPayLink,
  PaymentLinkError,
} from '@/lib/services/payment-link';

export async function POST(request: NextRequest) {
  try {
    await connectDB();
    const auth = await requireAuth();
    if ('error' in auth) return auth.error;

    let orderNumber = '';
    let customAmount: number | undefined;
    let currencyCode = '';
    let source = '';

    try {
      const body = await request.json();
      orderNumber =
        typeof body?.orderNumber === 'string' ? body.orderNumber.trim() : '';
      currencyCode =
        typeof body?.currencyCode === 'string' ? body.currencyCode.trim() : '';
      source = typeof body?.source === 'string' ? body.source.trim() : '';
      if (
        body &&
        body.customAmount !== undefined &&
        body.customAmount !== null &&
        body.customAmount !== ''
      ) {
        const parsed = Number(body.customAmount);
        if (Number.isFinite(parsed)) {
          customAmount = parsed;
        }
      }
    } catch {
      return NextResponse.json(
        { success: false, error: 'Invalid request payload' },
        { status: 400 },
      );
    }

    const user = {
      userId: auth.user.userId,
      name: auth.user.name,
      email: auth.user.email,
    };

    let payload;

    if (orderNumber) {
      const order = await Order.findOne({ orderNumber }).lean();
      if (!order) {
        return NextResponse.json(
          { success: false, error: 'Order not found' },
          { status: 404 },
        );
      }

      payload = await createPayLinkForOrder({
        order,
        user,
        customAmount,
      });
    } else {
      if (customAmount === undefined) {
        return NextResponse.json(
          {
            success: false,
            error:
              'For standalone links, custom amount is required when no order number is provided.',
          },
          { status: 400 },
        );
      }

      if (!currencyCode) {
        return NextResponse.json(
          {
            success: false,
            error:
              'For standalone links, currency code is required when no order number is provided.',
          },
          { status: 400 },
        );
      }

      payload = await createStandaloneCustomPayLink({
        amount: customAmount,
        currencyCode,
        source,
        user,
      });
    }

    return NextResponse.json({ success: true, data: payload });
  } catch (error) {
    if (error instanceof PaymentLinkError) {
      return NextResponse.json(
        { success: false, error: error.message },
        { status: error.status },
      );
    }

    console.error('Error creating payments pay link:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to create pay link' },
      { status: 500 },
    );
  }
}
