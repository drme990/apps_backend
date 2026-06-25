import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import Order from '@/lib/models/Order';
import { createPayment, getEasykashCashExpiryHours } from '@/lib/services/easykash';
import { convertCurrency } from '@/lib/services/currency';
import { logActivity } from '@/lib/services/logger';
import { randomBytes } from 'crypto';

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

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess(['orders', 'execution']);
    if ('error' in auth) return auth.error;

    const { id } = await params;
    const order = await Order.findById(id).lean();
    if (!order) {
      return NextResponse.json(
        { success: false, error: 'Order not found' },
        { status: 404 },
      );
    }

    // Only allow regenerating for pending EasyKash orders
    if (order.status !== 'pending') {
      return NextResponse.json(
        { success: false, error: 'Can only regenerate link for pending orders' },
        { status: 400 },
      );
    }

    const billingData = order.billingData;
    if (!billingData) {
      return NextResponse.json(
        { success: false, error: 'Order has no billing data' },
        { status: 400 },
      );
    }

    const currencyUpper = order.currency.toUpperCase();
    let easykashAmount = order.totalAmount;
    let paymentCurrency = currencyUpper;

    const EASYKASH_CURRENCIES = ['EGP', 'USD', 'SAR', 'EUR'];
    if (!EASYKASH_CURRENCIES.includes(currencyUpper)) {
      try {
        const convertedAmount = await convertCurrency(
          order.totalAmount,
          currencyUpper,
          'EGP',
        );
        if (Number.isFinite(convertedAmount) && convertedAmount > 0) {
          easykashAmount = Math.ceil(convertedAmount);
          paymentCurrency = 'EGP';
        }
      } catch {
        // Check for EGP product price fallback
        const item = order.items?.[0];
        if (item) {
          const Product = (await import('@/lib/models/Product')).default;
          const product = await Product.findById(item.productId).lean();
          const selectedSize = product?.sizes?.[item.sizeIndex ?? 0];
          const egpPriceEntry = selectedSize?.prices?.find(
            (p: { currencyCode: string; amount: number }) =>
              p.currencyCode === 'EGP',
          );
          if (
            egpPriceEntry &&
            typeof egpPriceEntry.amount === 'number' &&
            egpPriceEntry.amount > 0
          ) {
            easykashAmount = Math.ceil(egpPriceEntry.amount * (item.quantity ?? 1));
            paymentCurrency = 'EGP';
          } else {
            return NextResponse.json(
              {
                success: false,
                error: `Unable to convert ${currencyUpper} amount to EGP and no EGP product price is configured.`,
              },
              { status: 500 },
            );
          }
        }
      }
    }

    if (easykashAmount <= 1) {
      return NextResponse.json(
        {
          success: false,
          error: `Payment amount is too low. Minimum accepted by the payment gateway is 2 ${paymentCurrency}.`,
        },
        { status: 400 },
      );
    }

    const sourceBaseUrls: Record<string, string> = {
      manasik: process.env.MANASIK_URL || 'https://www.manasik.net',
      ghadaq: process.env.GHADAQ_URL || 'https://www.ghadaqplus.com',
    };
    const baseUrl =
      sourceBaseUrls[order.source || 'manasik'] || sourceBaseUrls.manasik;

    const cashExpiryHours = getEasykashCashExpiryHours();
    const paymentId = generatePaymentId();

    const getPaymentAttemptNumber = (o: { payments?: unknown[] }): number =>
      (o.payments?.length ?? 0) + 1;

    const initialPaymentAttemptNum = getPaymentAttemptNumber(order);
    const existingReferences = new Set(
      (order.payments ?? []).map(
        (payment: { easykashOrderId?: string }) => payment.easykashOrderId,
      ),
    );
    let paymentAttemptNum = initialPaymentAttemptNum;
    const maxReferenceRetries = 5;

    let easykashResponse: Awaited<ReturnType<typeof createPayment>> | null = null;
    let easykashOrderId: string | null = null;

    for (let attempt = 0; attempt < maxReferenceRetries; attempt += 1) {
      let candidateReference = `${order.orderNumber}-P${paymentAttemptNum}`;
      while (existingReferences.has(candidateReference)) {
        paymentAttemptNum += 1;
        candidateReference = `${order.orderNumber}-P${paymentAttemptNum}`;
      }

      try {
        easykashResponse = await createPayment({
          amount: easykashAmount,
          currency: paymentCurrency,
          name: billingData.fullName.trim(),
          email: billingData.email.trim().toLowerCase(),
          mobile: billingData.phone.trim(),
          cashExpiry: cashExpiryHours,
          redirectUrl: `${baseUrl}/payment/status?orderNumber=${encodeURIComponent(order.orderNumber)}`,
          customerReference: candidateReference,
        });
        easykashOrderId = candidateReference;
        break;
      } catch (gatewayError) {
        if (isCustomerReferenceAlreadyUsedError(gatewayError)) {
          existingReferences.add(candidateReference);
          paymentAttemptNum += 1;
          continue;
        }
        throw gatewayError;
      }
    }

    if (!easykashResponse || !easykashOrderId) {
      throw new Error('Unable to allocate a unique EasyKash customerReference');
    }

    // Append new payment record
    const newPayment = {
      paymentId,
      easykashOrderId,
      orderAmount: order.totalAmount,
      gatewayAmount: easykashAmount,
      gatewayCurrency: paymentCurrency,
      amount: order.totalAmount,
      currency: currencyUpper,
      status: 'pending' as const,
      redirectUrl: easykashResponse.redirectUrl,
      expiresAt: new Date(Date.now() + cashExpiryHours * 60 * 60 * 1000),
      createdAt: new Date(),
    };

    await Order.findByIdAndUpdate(id, {
      $push: { payments: newPayment },
    });

    await logActivity({
      userId: auth.user.userId,
      userName: auth.user.name,
      userEmail: auth.user.email,
      action: 'update',
      resource: 'order',
      resourceId: id,
      details: `Regenerated EasyKash payment link: ${easykashOrderId}`,
    });

    return NextResponse.json({
      success: true,
      data: {
        checkoutUrl: easykashResponse.redirectUrl,
        expiresAt: newPayment.expiresAt,
      },
    });
  } catch (error) {
    console.error('Regenerate payment link error:', error);
    const message =
      error instanceof Error ? error.message : 'Failed to regenerate payment link';
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 },
    );
  }
}
