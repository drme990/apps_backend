import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import Order, { type IPayment } from '@/lib/models/Order';
import {
  createPayment,
  getEasykashCashExpiryHours,
  inquirePayment,
  mapEasykashStatusToOrderStatus,
} from '@/lib/services/easykash';
import { convertCurrency } from '@/lib/services/currency';
import {
  calculateOrderFinancials,
  getPaymentOrderAmount,
} from '@/lib/services/order-financials';
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

function isCustomerReferenceAlreadyUsedError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  const message = error.message.toLowerCase();
  return (
    message.includes('customerreference') &&
    (message.includes('already used') || message.includes('already exists'))
  );
}

function getRemainingAttemptNumber(
  orderNumber: string,
  payments: IPayment[],
): number {
  const prefix = `${orderNumber}-p`;
  const attempts = payments
    .map((payment) => {
      const value = payment.easykashOrderId || '';
      if (!value.toLowerCase().startsWith(prefix.toLowerCase())) {
        return 0;
      }

      const suffix = value.slice(prefix.length);
      const parsed = Number.parseInt(suffix, 10);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
    })
    .filter((n) => n > 0);

  if (!attempts.length) return 1;
  return Math.max(...attempts) + 1;
}

function getInitialAttemptNumber(
  orderNumber: string,
  payments: IPayment[],
): number {
  const prefix = `${orderNumber}-P`;
  const attempts = payments
    .map((payment) => {
      const value = payment.easykashOrderId || '';
      if (!value.toUpperCase().startsWith(prefix.toUpperCase())) {
        return 0;
      }

      const suffix = value.slice(prefix.length);
      const parsed = Number.parseInt(suffix, 10);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
    })
    .filter((n) => n > 0);

  if (!attempts.length) return 1;
  return Math.max(...attempts) + 1;
}

function getInitialPaymentAmount(order: {
  currency?: string;
  totalAmount?: number;
  payments?: Array<{
    amount?: number;
    currency?: string;
    orderAmount?: number;
    easykashOrderId?: string;
    createdAt?: Date;
  }>;
}): number {
  const initialAttempts = (order.payments || [])
    .filter((payment) => (payment.easykashOrderId || '').includes('-P'))
    .sort((a, b) => {
      const aTime = new Date(a.createdAt || 0).getTime();
      const bTime = new Date(b.createdAt || 0).getTime();
      return aTime - bTime;
    });

  const initialPayment = initialAttempts[0];
  if (initialPayment) {
    const initialAmount = getPaymentOrderAmount(order, initialPayment);
    if (initialAmount > 0) {
      return initialAmount;
    }
  }

  return order.totalAmount ?? 0;
}

function normalizeStoredRedirectUrl(url: string): string {
  return url.replace('://easykash.net//', '://easykash.net/');
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

    let { totalPaid, remainingAmount } = calculateOrderFinancials(order);
    const hasPaidPayment = totalPaid > 0;
    const targetStatusForBalance =
      remainingAmount > 0 && hasPaidPayment
        ? 'partial-paid'
        : remainingAmount <= 0
          ? 'paid'
          : null;
    const shouldSyncStatus =
      targetStatusForBalance !== null &&
      order.status !== 'completed' &&
      order.status !== targetStatusForBalance;

    // Keep stored financial fields in sync with actual paid payment records.
    if (
      (order.paidAmount ?? 0) !== totalPaid ||
      (order.remainingAmount ?? 0) !== remainingAmount ||
      shouldSyncStatus
    ) {
      order.paidAmount = totalPaid;
      order.remainingAmount = remainingAmount;

      if (shouldSyncStatus && targetStatusForBalance) {
        order.status = targetStatusForBalance;
      }

      await order.save();
    }

    // Check if order has remaining balance
    if (remainingAmount <= 0) {
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
    const nowMs = Date.now();
    const existingValidPayment = (order.payments ?? [])
      .filter(
        (p: { status: string; expiresAt?: Date; redirectUrl?: string }) =>
          p.status === 'pending' &&
          p.expiresAt &&
          new Date(p.expiresAt).getTime() > nowMs,
      )
      .sort((a, b) => {
        const aTime = new Date(a.createdAt || 0).getTime();
        const bTime = new Date(b.createdAt || 0).getTime();
        return bTime - aTime;
      })
      .find((p) => !!p.redirectUrl);

    if (existingValidPayment && existingValidPayment.redirectUrl) {
      // Verify latest pending payment before reuse to avoid redirecting to stale gateway URLs.
      try {
        const inquiry = await inquirePayment(
          existingValidPayment.easykashOrderId,
        );
        const syncedStatus = mapEasykashStatusToOrderStatus(inquiry.status);

        if (syncedStatus === 'pending') {
          const normalizedRedirectUrl = normalizeStoredRedirectUrl(
            existingValidPayment.redirectUrl,
          );
          if (normalizedRedirectUrl !== existingValidPayment.redirectUrl) {
            existingValidPayment.redirectUrl = normalizedRedirectUrl;
            await order.save();
          }

          log('info', 'create_link.reused_existing', {
            ip,
            traceId,
            orderNumber,
          });
          return NextResponse.json({
            success: true,
            data: {
              redirectUrl: normalizedRedirectUrl,
              paymentId: (existingValidPayment as IPayment).paymentId,
            },
          });
        }

        existingValidPayment.status =
          syncedStatus === 'paid' ? 'paid' : 'expired';
        if (existingValidPayment.status === 'paid') {
          existingValidPayment.paidAt = new Date();
        }

        ({ totalPaid, remainingAmount } = calculateOrderFinancials(order));
        order.paidAmount = totalPaid;
        order.remainingAmount = remainingAmount;
        if (remainingAmount <= 0) {
          order.status = 'paid';
        } else if (totalPaid > 0) {
          order.status = 'partial-paid';
        }
        await order.save();

        if (remainingAmount <= 0) {
          return NextResponse.json(
            { success: false, error: 'Order has no remaining balance' },
            { status: 400 },
          );
        }
      } catch (inquiryError) {
        // If inquiry fails, don't reuse old links; create a fresh payment instead.
        log('warn', 'create_link.inquiry_failed_create_new', {
          ip,
          traceId,
          orderNumber,
          reference: existingValidPayment.easykashOrderId,
          details:
            inquiryError instanceof Error
              ? inquiryError.message.slice(0, 180)
              : 'unknown',
        });
      }
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

    const paymentAttemptNum = hasPaidPayment
      ? getRemainingAttemptNumber(order.orderNumber, order.payments ?? [])
      : getInitialAttemptNumber(order.orderNumber, order.payments ?? []);
    const paymentId = generatePaymentId();

    const sourceBaseUrls: Record<string, string> = {
      manasik: process.env.MANASIK_URL || 'https://www.manasik.net',
      ghadaq: process.env.GHADAQ_URL || 'https://www.ghadaqplus.com',
    };
    const baseUrl =
      sourceBaseUrls[order.source || 'manasik'] || sourceBaseUrls.manasik;

    const orderPaymentAmount = hasPaidPayment
      ? remainingAmount
      : getInitialPaymentAmount(order);

    let easykashAmount = Math.ceil(orderPaymentAmount);
    let paymentCurrency = (order.currency || 'EGP').toUpperCase().trim();

    const EASYKASH_CURRENCIES = ['EGP', 'USD', 'SAR', 'EUR'];
    if (!EASYKASH_CURRENCIES.includes(paymentCurrency)) {
      const convertedAmount = await convertCurrency(
        orderPaymentAmount,
        paymentCurrency,
        'EGP',
      );
      easykashAmount = Math.ceil(convertedAmount);
      paymentCurrency = 'EGP';
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

    const cashExpiryHours = getEasykashCashExpiryHours();
    let easykashResponse: Awaited<ReturnType<typeof createPayment>> | null =
      null;
    let easykashOrderId: string | null = null;
    let nextAttemptNum = paymentAttemptNum;
    const maxReferenceRetries = 5;
    const existingReferences = new Set(
      (order.payments ?? []).map((payment) => payment.easykashOrderId),
    );

    try {
      for (let attempt = 0; attempt < maxReferenceRetries; attempt += 1) {
        let candidateReference = hasPaidPayment
          ? `${order.orderNumber}-p${nextAttemptNum}`
          : `${order.orderNumber}-P${nextAttemptNum}`;

        while (existingReferences.has(candidateReference)) {
          nextAttemptNum += 1;
          candidateReference = hasPaidPayment
            ? `${order.orderNumber}-p${nextAttemptNum}`
            : `${order.orderNumber}-P${nextAttemptNum}`;
        }

        try {
          easykashResponse = await createPayment({
            amount: easykashAmount,
            currency: paymentCurrency,
            name: order.billingData.fullName,
            email: order.billingData.email,
            mobile: order.billingData.phone,
            cashExpiry: cashExpiryHours,
            redirectUrl: `${baseUrl}/payment/status?orderNumber=${order.orderNumber}`,
            customerReference: candidateReference,
          });

          easykashOrderId = candidateReference;
          break;
        } catch (gatewayError) {
          if (isCustomerReferenceAlreadyUsedError(gatewayError)) {
            existingReferences.add(candidateReference);
            nextAttemptNum += 1;
            continue;
          }

          throw gatewayError;
        }
      }

      if (!easykashResponse || !easykashOrderId) {
        throw new Error(
          'Unable to allocate a unique EasyKash customerReference',
        );
      }
    } catch (error) {
      console.error('EasyKash payment creation failed:', error);
      log('error', 'create_link.easykash_error', { ip, traceId, orderNumber });
      return NextResponse.json(
        { success: false, error: 'Payment gateway error. Please try again.' },
        { status: 502 },
      );
    }

    const newPayment = {
      paymentId,
      easykashOrderId,
      orderAmount: orderPaymentAmount,
      gatewayAmount: easykashAmount,
      gatewayCurrency: paymentCurrency,
      amount: orderPaymentAmount,
      currency: (order.currency || 'EGP').toUpperCase().trim(),
      status: 'pending' as const,
      redirectUrl: easykashResponse.redirectUrl,
      expiresAt: new Date(Date.now() + cashExpiryHours * 60 * 60 * 1000),
      createdAt: new Date(),
    };

    if (!order.payments) {
      order.payments = [];
    }
    order.payments.push(newPayment);

    if (!order.paymentAttempts) {
      order.paymentAttempts = [];
    }
    order.paymentAttempts.push({
      createdAt: new Date(),
      ip,
      userId: undefined,
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
