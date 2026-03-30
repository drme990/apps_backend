import { NextRequest, NextResponse } from 'next/server';
import mongoose from 'mongoose';
import { connectDB } from '@/lib/db';
import { captureException } from '@/lib/services/error-monitor';
import Order from '@/lib/models/Order';
import Product from '@/lib/models/Product';
import Booking from '@/lib/models/Booking';
import { getAuthUser } from '@/lib/auth';
import { AppId, getUserModelByAppId } from '@/lib/auth/app-users';
import { generateToken } from '@/lib/services/jwt';
import {
  findReservationInputByField,
  matchReservationOption,
  normalizeReservationFields,
} from '@/lib/reservation-fields';
import {
  createPayment,
  getEasykashCashExpiryHours,
} from '@/lib/services/easykash';
import {
  acquirePartialPaymentCreationLock,
  buildPartialPaymentIdentity,
  canUserCreatePartialPayment,
  type PartialPaymentCreationLock,
} from '@/lib/services/partial-payment-guard';
import { validateCoupon } from '@/lib/services/coupon';
import { trackInitiateCheckout } from '@/lib/services/fb-capi';
import { uploadImage } from '@/lib/services/cloudinary';
import { rateLimit, getClientIp } from '@/lib/rate-limit';
import { log } from '@/lib/request-logger';
import { parseJsonBody } from '@/lib/validation/http';
import { checkoutSchema } from '@/lib/validation/schemas';
import { randomBytes } from 'crypto';

function toIsoLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function generatePaymentId(): string {
  return `pay_${randomBytes(12).toString('hex')}`;
}

function getPaymentAttemptNumber(order: { payments?: unknown[] }): number {
  return (order.payments?.length ?? 0) + 1;
}

function setAuthCookie(
  response: NextResponse,
  appId: Exclude<AppId, 'admin_panel'>,
  token: string,
) {
  const isProduction = process.env.NODE_ENV === 'production';
  response.cookies.set(`${appId}-token`, token, {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? 'none' : 'lax',
    maxAge: 7 * 24 * 60 * 60,
    path: '/',
  });
}

async function releasePartialPaymentLock(
  lock: PartialPaymentCreationLock | null,
): Promise<void> {
  if (!lock) return;

  try {
    await lock.release();
  } catch {
    // Ignore lock release failures to avoid masking checkout errors.
  }
}

export async function POST(request: NextRequest) {
  let partialPaymentLock: PartialPaymentCreationLock | null = null;

  try {
    // Rate limit: 5 checkout attempts per IP per minute
    const ip = getClientIp(request);
    const traceId = request.headers.get('x-request-id') ?? undefined;
    const rl = rateLimit(`checkout:${ip}`, 5, 60_000);
    if (!rl.allowed) {
      log('warn', 'checkout.rate_limited', { ip, traceId });
      return NextResponse.json(
        { success: false, error: 'Too many requests. Please try again later.' },
        { status: 429 },
      );
    }

    await connectDB();
    const parsed = await parseJsonBody(request, checkoutSchema);
    if (!parsed.success) return parsed.response;
    const body = parsed.data;
    log('info', 'checkout.initiated', { ip, traceId, source: body?.source });

    const {
      productId,
      quantity = 1,
      currency,
      billingData,
      locale = 'ar',
      couponCode,
      referralId,
      sizeIndex,
      paymentOption = 'full',
      customPaymentAmount,
      termsAgreed,
      reservationData,
      source,
      deviceFingerprint,
      createAccount,
      accountPassword,
    } = body;

    const orderSource: 'manasik' | 'ghadaq' =
      source === 'ghadaq' ? 'ghadaq' : 'manasik';
    const checkoutAppId: Exclude<AppId, 'admin_panel'> =
      orderSource === 'ghadaq' ? 'ghadaq' : 'manasik';

    const sessionUser = await getAuthUser(checkoutAppId);
    const isAuthenticated = !!sessionUser;
    const requiresAccountForPayment =
      paymentOption === 'half' || paymentOption === 'custom';
    const shouldCreateOrLoginFromCheckout =
      Boolean(createAccount) || requiresAccountForPayment;

    let tokenToSet: string | null = null;
    let effectiveUserId: string | null = sessionUser?.userId || null;

    if (!isAuthenticated && shouldCreateOrLoginFromCheckout) {
      const normalizedPassword =
        typeof accountPassword === 'string' ? accountPassword.trim() : '';

      if (normalizedPassword.length < 6) {
        return NextResponse.json(
          {
            success: false,
            error:
              'A password with at least 6 characters is required for this payment option',
          },
          { status: 400 },
        );
      }

      const UserModel = getUserModelByAppId(
        checkoutAppId,
      ) as unknown as mongoose.Model<
        mongoose.Document & {
          _id: mongoose.Types.ObjectId;
          email: string;
          name: string;
          password?: string;
          phone?: string;
          country?: string;
          appId?: string;
          comparePassword(candidatePassword: string): Promise<boolean>;
        }
      >;
      const normalizedEmail = billingData.email.trim().toLowerCase();
      const existingUser = await UserModel.findOne({ email: normalizedEmail })
        .select('+password')
        .lean(false);

      if (existingUser) {
        if ('isBanned' in existingUser && existingUser.isBanned) {
          return NextResponse.json(
            { success: false, error: 'Your account has been banned' },
            { status: 403 },
          );
        }

        const isMatch = await existingUser.comparePassword(normalizedPassword);
        if (!isMatch) {
          return NextResponse.json(
            {
              success: false,
              error: 'This email is already registered. Please login first.',
              code: 'REGISTERED_EMAIL_LOGIN_REQUIRED',
              redirectTo: `/auth/login?email=${encodeURIComponent(normalizedEmail)}&from=checkout`,
            },
            { status: 401 },
          );
        }

        tokenToSet = generateToken({
          _id: existingUser._id.toString(),
          appId: checkoutAppId,
          name: existingUser.name,
          email: existingUser.email,
        });
        effectiveUserId = existingUser._id.toString();
      } else {
        const newUser = await UserModel.create({
          name: billingData.fullName.trim(),
          email: normalizedEmail,
          password: normalizedPassword,
          phone: billingData.phone.trim(),
          country: billingData.country?.trim() || '',
          appId: checkoutAppId,
        });

        tokenToSet = generateToken({
          _id: newUser._id.toString(),
          appId: checkoutAppId,
          name: newUser.name,
          email: newUser.email,
        });
        effectiveUserId = newUser._id.toString();
      }
    }

    if (!termsAgreed) {
      return NextResponse.json(
        { success: false, error: 'Terms and conditions must be agreed to' },
        { status: 400 },
      );
    }

    const product = await Product.findOne({
      _id: productId,
      isDeleted: { $ne: true },
    });
    if (!product) {
      return NextResponse.json(
        { success: false, error: 'Product not found' },
        { status: 404 },
      );
    }

    if (!product.inStock) {
      return NextResponse.json(
        { success: false, error: 'Product is out of stock' },
        { status: 400 },
      );
    }

    const booking = await Booking.findOne({ key: 'global' }).lean();
    const blockedExecutionDates = new Set(
      (booking?.blockedExecutionDates ?? []).filter((value: string) =>
        /^\d{4}-\d{2}-\d{2}$/.test(value),
      ),
    );

    // Validate reservation answers against product reservation field config
    const reservationInput = Array.isArray(reservationData)
      ? reservationData
      : [];
    const normalizedReservationData = normalizeReservationFields(
      product.reservationFields,
    ).map((field) => {
      const rawValue = findReservationInputByField(
        field,
        reservationInput,
      )?.value;
      const value = typeof rawValue === 'string' ? rawValue.trim() : '';
      return {
        key: field.key,
        label: field.label,
        type: field.type,
        value,
        required: !!field.required,
        maxLength: field.maxLength,
        options: field.options || [],
      };
    });

    const reservationAnswers: Array<{
      key:
        | 'intention'
        | 'sacrificeFor'
        | 'gender'
        | 'isAlive'
        | 'shortDuaa'
        | 'photo'
        | 'executionDate';
      label: { ar: string; en: string };
      type:
        | 'text'
        | 'textarea'
        | 'number'
        | 'date'
        | 'select'
        | 'radio'
        | 'picture';
      value: string;
    }> = [];

    for (const field of normalizedReservationData) {
      if (field.required && !field.value) {
        return NextResponse.json(
          {
            success: false,
            error: 'Missing required reservation field',
          },
          { status: 400 },
        );
      }

      if (!field.value) continue;

      if (
        (field.type === 'text' || field.type === 'textarea') &&
        field.maxLength &&
        field.value.length > field.maxLength
      ) {
        return NextResponse.json(
          {
            success: false,
            error: `Reservation value exceeds max length (${field.maxLength})`,
          },
          { status: 400 },
        );
      }

      if (
        (field.type === 'select' || field.type === 'radio') &&
        field.options.length > 0
      ) {
        const isValidOption = field.options.some(
          (opt: { ar: string; en: string }) =>
            opt.ar === field.value || opt.en === field.value,
        );
        if (!isValidOption) {
          return NextResponse.json(
            {
              success: false,
              error: 'Invalid reservation option',
            },
            { status: 400 },
          );
        }
      }

      let finalValue = field.value;

      if (field.key === 'executionDate' && finalValue) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(finalValue)) {
          return NextResponse.json(
            { success: false, error: 'Execution date format is invalid' },
            { status: 400 },
          );
        }

        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const todayIso = toIsoLocalDate(today);
        if (finalValue <= todayIso) {
          return NextResponse.json(
            {
              success: false,
              error: 'Execution date must be after today',
            },
            { status: 400 },
          );
        }

        if (blockedExecutionDates.has(finalValue)) {
          return NextResponse.json(
            { success: false, error: 'Execution date is not available' },
            { status: 400 },
          );
        }
      }

      if (
        (field.type === 'select' || field.type === 'radio') &&
        field.options.length > 0
      ) {
        const matchedOption = matchReservationOption(field, finalValue);
        if (!matchedOption) {
          return NextResponse.json(
            {
              success: false,
              error: 'Invalid reservation option',
            },
            { status: 400 },
          );
        }
        finalValue = matchedOption.ar;
      }

      if (field.type === 'picture') {
        const isDataImage = finalValue.startsWith('data:image/');
        const isHttpUrl = /^https?:\/\//i.test(finalValue);

        if (!isDataImage && !isHttpUrl) {
          return NextResponse.json(
            {
              success: false,
              error: 'Invalid reservation picture format',
            },
            { status: 400 },
          );
        }

        // Store reservation pictures as CDN URLs instead of large base64 strings.
        if (isDataImage) {
          const uploaded = await uploadImage(finalValue, 'reservations');
          if (!uploaded.success || !uploaded.url) {
            return NextResponse.json(
              {
                success: false,
                error: uploaded.error || 'Failed to upload reservation picture',
              },
              { status: 500 },
            );
          }
          finalValue = uploaded.url;
        }
      }

      if (finalValue) {
        reservationAnswers.push({
          key: field.key,
          label: field.label,
          type: field.type,
          value: finalValue,
        });
      }
    }

    const currencyUpper = currency.toUpperCase();

    const activeSizeIndex =
      sizeIndex !== undefined &&
      sizeIndex !== null &&
      sizeIndex >= 0 &&
      sizeIndex < product.sizes.length
        ? sizeIndex
        : 0;
    const selectedSize = product.sizes[activeSizeIndex];
    let unitPrice = selectedSize.price ?? 0;

    const sizeCurrencyPrice = selectedSize.prices?.find(
      (p: { currencyCode: string; amount: number }) =>
        p.currencyCode === currencyUpper,
    );
    if (sizeCurrencyPrice) {
      unitPrice = sizeCurrencyPrice.amount;
    } else if (product.baseCurrency !== currencyUpper) {
      return NextResponse.json(
        {
          success: false,
          error: `Price not available in ${currencyUpper}. Available in: ${product.baseCurrency}`,
        },
        { status: 400 },
      );
    }

    if (unitPrice <= 0) {
      return NextResponse.json(
        {
          success: false,
          error: `Product price is not configured for ${currencyUpper}`,
        },
        { status: 400 },
      );
    }

    const totalAmount = unitPrice * quantity;

    let couponDiscount = 0;
    let appliedCouponCode: string | undefined;
    let appliedCouponId: string | undefined;
    if (couponCode) {
      const couponResult = await validateCoupon(
        couponCode,
        totalAmount,
        currencyUpper,
        productId,
      );
      if (!couponResult.valid) {
        return NextResponse.json(
          { success: false, error: couponResult.error },
          { status: 400 },
        );
      }
      couponDiscount = couponResult.discountAmount || 0;
      appliedCouponCode = couponResult.coupon?.code;
      appliedCouponId = couponResult.coupon?._id?.toString();
    }

    const amountAfterDiscount = totalAmount - couponDiscount;

    let payAmount = amountAfterDiscount;
    let isPartialPayment = false;
    let paymentType: 'full' | 'half' | 'partial' = 'full';

    if (paymentOption === 'half') {
      isPartialPayment = true;
      paymentType = 'half';
      payAmount = Math.ceil(amountAfterDiscount / 2);
    } else if (paymentOption === 'custom' && customPaymentAmount) {
      if (!product.partialPayment?.isAllowed) {
        return NextResponse.json(
          {
            success: false,
            error: 'This product does not support custom payment amounts',
          },
          { status: 400 },
        );
      }

      let minPayment = Math.ceil(amountAfterDiscount / 2);
      const minimumPaymentType =
        product.partialPayment?.minimumType || 'percentage';
      const currencyMinimum = product.partialPayment?.minimumPayments?.find(
        (mp: { currencyCode: string; value: number }) =>
          mp.currencyCode === currencyUpper,
      );

      if (currencyMinimum) {
        if (minimumPaymentType === 'percentage') {
          minPayment = Math.ceil(
            (amountAfterDiscount * currencyMinimum.value) / 100,
          );
        } else {
          minPayment = Math.ceil(currencyMinimum.value);
        }
      }

      if (customPaymentAmount < minPayment) {
        return NextResponse.json(
          {
            success: false,
            error: `Minimum payment amount is ${minPayment} ${currencyUpper}`,
          },
          { status: 400 },
        );
      }

      if (customPaymentAmount > amountAfterDiscount) {
        return NextResponse.json(
          {
            success: false,
            error: 'Custom payment amount cannot exceed the order total',
          },
          { status: 400 },
        );
      }

      isPartialPayment = customPaymentAmount < amountAfterDiscount;
      paymentType = isPartialPayment ? 'partial' : 'full';
      payAmount = customPaymentAmount;
    }

    const partialPaymentIdentity = buildPartialPaymentIdentity({
      source: orderSource,
      userId: effectiveUserId,
      email: billingData.email,
      phone: billingData.phone,
      ip,
      fingerprint: deviceFingerprint,
    });

    if (paymentType === 'partial') {
      partialPaymentLock = await acquirePartialPaymentCreationLock({
        source: orderSource,
        userId: effectiveUserId,
        email: billingData.email,
        phone: billingData.phone,
        ip,
        fingerprint: deviceFingerprint,
      });

      if (!partialPaymentLock.acquired) {
        return NextResponse.json(
          {
            success: false,
            code: 'PARTIAL_PAYMENT_LOCKED',
            error:
              'A partial payment request is already being processed. Please try again in a few seconds.',
          },
          { status: 409 },
        );
      }

      const guardDecision = await canUserCreatePartialPayment({
        source: orderSource,
        userId: effectiveUserId,
        email: billingData.email,
        phone: billingData.phone,
        ip,
        fingerprint: deviceFingerprint,
      });

      if (!guardDecision.allowed) {
        await releasePartialPaymentLock(partialPaymentLock);
        partialPaymentLock = null;

        return NextResponse.json(
          {
            success: false,
            code: guardDecision.reasonCode || 'ACTIVE_PARTIAL_ORDER',
            error:
              guardDecision.message ||
              'You already have an active partial payment order. Complete it before creating a new one.',
          },
          { status: 409 },
        );
      }
    }

    const order = await Order.create({
      items: [
        {
          productId: product._id.toString(),
          productSlug: product.slug,
          productName: { ar: product.name.ar, en: product.name.en },
          price: unitPrice,
          currency: currencyUpper,
          quantity,
        },
      ],
      userId: effectiveUserId || undefined,
      isGuest: !effectiveUserId,
      totalAmount: payAmount,
      fullAmount: amountAfterDiscount,
      paidAmount: 0,
      remainingAmount: amountAfterDiscount,
      isPartialPayment,
      paymentType,
      sizeIndex: activeSizeIndex,
      currency: currencyUpper,
      status: 'pending',
      billingData: {
        fullName: billingData.fullName,
        email: partialPaymentIdentity.normalizedEmail || billingData.email,
        phone: billingData.phone,
        country: billingData.country || 'N/A',
      },
      referralId: referralId || undefined,
      couponCode: appliedCouponCode,
      couponId: appliedCouponId,
      couponDiscount,
      termsAgreedAt: new Date(),
      reservationData: reservationAnswers,
      source: orderSource,
      normalizedEmail: partialPaymentIdentity.normalizedEmail,
      normalizedPhone: partialPaymentIdentity.normalizedPhone,
      latestClientIp: partialPaymentIdentity.normalizedIp,
      deviceFingerprint: partialPaymentIdentity.normalizedFingerprint,
      countryCode: billingData.country || '',
      locale,
      payments: [],
      paymentAttempts: [],
    });

    await releasePartialPaymentLock(partialPaymentLock);
    partialPaymentLock = null;

    // FB CAPI: InitiateCheckout (fire-and-forget)
    const reqIp =
      partialPaymentIdentity.normalizedIp ||
      request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
      request.headers.get('x-real-ip') ||
      '';
    const reqUa = request.headers.get('user-agent') || '';

    trackInitiateCheckout({
      productId: product._id.toString(),
      productName: product.name.en || product.name.ar,
      value: payAmount,
      currency: currencyUpper,
      numItems: quantity,
      sourceUrl: `${process.env.BASE_URL || 'https://www.manasik.net'}/checkout`,
      userData: {
        em: billingData.email,
        ph: billingData.phone,
        fn: billingData.fullName.split(' ')[0],
        ln:
          billingData.fullName.split(' ').slice(1).join(' ') ||
          billingData.fullName.split(' ')[0],
        country: billingData.country,
        client_ip_address: reqIp,
        client_user_agent: reqUa,
        external_id: order._id.toString(),
      },
    }).catch(() => {});

    // EasyKash payment
    if (!process.env.EASYKASH_API_KEY) {
      const response = NextResponse.json({
        success: true,
        data: {
          order: {
            _id: order._id,
            orderNumber: order.orderNumber,
            totalAmount: payAmount,
            fullAmount: amountAfterDiscount,
            remainingAmount: isPartialPayment
              ? amountAfterDiscount - payAmount
              : 0,
            isPartialPayment,
            couponDiscount,
            currency: currencyUpper,
            status: order.status,
          },
          checkoutUrl: null,
          message:
            'Payment gateway not configured. Order created successfully.',
        },
      });

      if (tokenToSet) {
        setAuthCookie(response, checkoutAppId, tokenToSet);
      }

      return response;
    }

    const sourceBaseUrls: Record<string, string> = {
      manasik: process.env.MANASIK_URL || 'https://www.manasik.net',
      ghadaq: process.env.GHADAQ_URL || 'https://www.ghadaqplus.com',
    };
    const baseUrl =
      sourceBaseUrls[order.source || 'manasik'] || sourceBaseUrls.manasik;

    const EASYKASH_CURRENCIES = ['EGP', 'USD', 'SAR', 'EUR'];
    let easykashAmount = payAmount;
    let paymentCurrency = currencyUpper;

    if (!EASYKASH_CURRENCIES.includes(currencyUpper)) {
      const egpPriceEntry = selectedSize.prices?.find(
        (p: { currencyCode: string; amount: number }) =>
          p.currencyCode === 'EGP',
      );
      const egpUnitPrice = egpPriceEntry?.amount ?? unitPrice;
      const egpTotal = egpUnitPrice * quantity;
      const couponRatio = totalAmount > 0 ? couponDiscount / totalAmount : 0;
      const egpAfterDiscount = egpTotal - egpTotal * couponRatio;
      const payRatio =
        amountAfterDiscount > 0 ? payAmount / amountAfterDiscount : 1;
      easykashAmount = Math.ceil(egpAfterDiscount * payRatio);
      paymentCurrency = 'EGP';
    }

    if (easykashAmount <= 1) {
      await Order.findByIdAndDelete(order._id);
      return NextResponse.json(
        {
          success: false,
          error: `Payment amount is too low. Minimum accepted by the payment gateway is 2 ${paymentCurrency}.`,
        },
        { status: 400 },
      );
    }

    // Generate payment ids and easykashOrderId before calling createPayment
    const paymentAttemptNum = getPaymentAttemptNumber(order);
    const easykashOrderId = `${order.orderNumber}-P${paymentAttemptNum}`;
    const paymentId = generatePaymentId();

    const cashExpiryHours = getEasykashCashExpiryHours();
    let easykashResponse: Awaited<ReturnType<typeof createPayment>>;
    try {
      easykashResponse = await createPayment({
        amount: easykashAmount,
        currency: paymentCurrency,
        name: billingData.fullName,
        email: billingData.email,
        mobile: billingData.phone,
        cashExpiry: cashExpiryHours,
        redirectUrl: `${baseUrl}/payment/status?orderNumber=${order.orderNumber}`,
        customerReference: easykashOrderId,
      });
    } catch (easykashError) {
      // Clean up the orphaned order so it doesn't block future attempts
      await Order.findByIdAndDelete(order._id);
      captureException(easykashError, {
        service: 'Checkout',
        operation: 'createPayment_EasyKash',
        severity: 'high',
        metadata: { easykashOrderId, orderNumber: order.orderNumber },
      });
      return NextResponse.json(
        { success: false, error: 'Payment gateway error. Please try again.' },
        { status: 502 },
      );
    }

    // Create first payment record in payments array with -P1 suffix
    order.payments = [
      {
        paymentId,
        easykashOrderId,
        amount: easykashAmount,
        currency: paymentCurrency,
        status: 'pending',
        redirectUrl: easykashResponse.redirectUrl,
        expiresAt: new Date(Date.now() + cashExpiryHours * 60 * 60 * 1000),
        createdAt: new Date(),
      },
    ];
    order.paymentAttempts = [
      {
        createdAt: new Date(),
        ip: ip || undefined,
        userId: effectiveUserId || undefined,
      },
    ];
    order.status = 'processing';
    await order.save();

    const response = NextResponse.json({
      success: true,
      data: {
        order: {
          _id: order._id,
          orderNumber: order.orderNumber,
          totalAmount: payAmount,
          fullAmount: amountAfterDiscount,
          remainingAmount: isPartialPayment
            ? amountAfterDiscount - payAmount
            : 0,
          isPartialPayment,
          couponDiscount,
          currency: currencyUpper,
          status: order.status,
        },
        checkoutUrl: easykashResponse.redirectUrl,
      },
    });

    if (tokenToSet) {
      setAuthCookie(response, checkoutAppId, tokenToSet);
    }

    return response;
  } catch (error) {
    await releasePartialPaymentLock(partialPaymentLock);

    captureException(error, {
      service: 'Checkout',
      operation: 'POST',
      severity: 'critical',
    });
    return NextResponse.json(
      { success: false, error: 'Failed to create checkout' },
      { status: 500 },
    );
  }
}
