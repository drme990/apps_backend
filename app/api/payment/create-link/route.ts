import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import Order, { type IPayment } from '@/lib/models/Order';
import { createPayment } from '@/lib/services/easykash';
import { getClientIp } from '@/lib/rate-limit';
import { log } from '@/lib/request-logger';
import { parseJsonBody } from '@/lib/validation/http';
import { z } from 'zod';
import { randomBytes } from 'crypto';

const createLinkSchema = z.object({
  orderNumber: z.string().min(1),
});

function generatePaymentId(): string {
  return `pay_${randomBytes(12).toString('hex')}`;
}

export async function POST(request: NextRequest) {
  try {
    const ip = getClientIp(request);
    const traceId = request.headers.get('x-request-id') ?? undefined;

    await connectDB();

    const parsed = await parseJsonBody(request, createLinkSchema);
    if (!parsed.success) return parsed.response;
    const { orderNumber } = parsed.data;

    log('info', 'create_link.initiated', { ip, traceId, orderNumber });

    // Find order
    const order = await Order.findOne({ orderNumber }).exec();
    if (!order) {
      return NextResponse.json(
        { success: false, error: 'Order not found' },
        { status: 404 },
      );
    }

    // Check if order has remaining balance
    if ((order.remainingAmount ?? 0) <= 0) {
      return NextResponse.json(
        { success: false, error: 'Order has no remaining balance' },
        { status: 400 },
      );
    }

    // Check if order is cancelled or refunded
    if (order.status === 'cancelled' || order.status === 'refunded') {
      return NextResponse.json(
        {
          success: false,
          error: `Cannot create payment link for ${order.status} orders`,
        },
        { status: 400 },
      );
    }

    // Rate limiting: max 3 per hour, max 10 per day per order
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const attemptsLastHour = (order.paymentAttempts ?? []).filter(
      (attempt: { createdAt: Date; ip?: string; userId?: string }) =>
        new Date(attempt.createdAt) > oneHourAgo &&
        (attempt.ip === ip || attempt.userId),
    ).length;

    const attemptsLastDay = (order.paymentAttempts ?? []).filter(
      (attempt: { createdAt: Date; ip?: string; userId?: string }) =>
        new Date(attempt.createdAt) > oneDayAgo &&
        (attempt.ip === ip || attempt.userId),
    ).length;

    if (attemptsLastHour >= 3) {
      log('warn', 'create_link.rate_limited_hour', {
        ip,
        traceId,
        orderNumber,
      });
      return NextResponse.json(
        {
          success: false,
          error:
            'Too many payment attempts in the last hour. Please try again later.',
        },
        { status: 429 },
      );
    }

    if (attemptsLastDay >= 10) {
      log('warn', 'create_link.rate_limited_day', { ip, traceId, orderNumber });
      return NextResponse.json(
        {
          success: false,
          error: 'Too many payment attempts today. Please try again tomorrow.',
        },
        { status: 429 },
      );
    }

    // Check for existing valid pending payment
    const now_ms = Date.now();
    const existingValidPayment = (order.payments ?? []).find(
      (p: { status: string; expiresAt?: Date; redirectUrl?: string }) =>
        p.status === 'pending' &&
        p.expiresAt &&
        new Date(p.expiresAt).getTime() > now_ms,
    );

    if (existingValidPayment && existingValidPayment.redirectUrl) {
      log('info', 'create_link.reused_existing', { ip, traceId, orderNumber });
      return NextResponse.json({
        success: true,
        data: {
          redirectUrl: existingValidPayment.redirectUrl,
          paymentId: (existingValidPayment as IPayment).paymentId,
        },
      });
    }

    // Create new payment link
    if (!process.env.EASYKASH_API_KEY) {
      return NextResponse.json(
        {
          success: false,
          error: 'Payment gateway not configured',
        },
        { status: 503 },
      );
    }

    const paymentAttemptNum = (order.payments?.length ?? 0) + 1;
    const easykashOrderId = `${order.orderNumber}-P${paymentAttemptNum}`;
    const paymentId = generatePaymentId();

    const sourceBaseUrls: Record<string, string> = {
      manasik: process.env.MANASIK_URL || 'https://www.manasik.net',
      ghadaq: process.env.GHADAQ_URL || 'https://www.ghadaqplus.com',
    };
    const baseUrl =
      sourceBaseUrls[order.source || 'manasik'] || sourceBaseUrls.manasik;

    const easykashAmount = order.remainingAmount!;
    const paymentCurrency = order.currency;

    const EASYKASH_CURRENCIES = ['EGP', 'USD', 'SAR', 'EUR'];
    if (!EASYKASH_CURRENCIES.includes(order.currency)) {
      // For currencies not supported by EasyKash, return error
      return NextResponse.json(
        {
          success: false,
          error: `Remaining balance currency (${order.currency}) is not supported for payment links`,
        },
        { status: 400 },
      );
    }

    if (easykashAmount <= 1) {
      return NextResponse.json(
        {
          success: false,
          error: `Remaining amount is too low. Minimum is 2 ${paymentCurrency}.`,
        },
        { status: 400 },
      );
    }

    let easykashResponse;
    try {
      easykashResponse = await createPayment({
        amount: easykashAmount,
        currency: paymentCurrency,
        name: order.billingData.fullName,
        email: order.billingData.email,
        mobile: order.billingData.phone,
        redirectUrl: `${baseUrl}/payment/status?orderNumber=${order.orderNumber}`,
        customerReference: easykashOrderId,
      });
    } catch (error) {
      console.error('EasyKash payment creation failed:', error);
      log('error', 'create_link.easykash_error', { ip, traceId, orderNumber });
      return NextResponse.json(
        { success: false, error: 'Payment gateway error. Please try again.' },
        { status: 502 },
      );
    }

    // Add new payment to payments array
    const newPayment = {
      paymentId,
      easykashOrderId,
      amount: easykashAmount,
      currency: paymentCurrency,
      status: 'pending' as const,
      redirectUrl: easykashResponse.redirectUrl,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours
      createdAt: new Date(),
    };

    if (!order.payments) {
      order.payments = [];
    }
    order.payments.push(newPayment);

    // Add attempt record
    if (!order.paymentAttempts) {
      order.paymentAttempts = [];
    }
    order.paymentAttempts.push({
      createdAt: new Date(),
      ip,
      userId: undefined, // Could be set if user is authenticated
    });

    await order.save();

    log('info', 'create_link.created', {
      ip,
      traceId,
      orderNumber,
      paymentId,
    });

    return NextResponse.json({
      success: true,
      data: {
        redirectUrl: easykashResponse.redirectUrl,
        paymentId,
      },
    });
  } catch (error) {
    console.error('Error creating payment link:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to create payment link' },
      { status: 500 },
    );
  }
}
