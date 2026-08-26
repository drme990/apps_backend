import { NextRequest, NextResponse } from 'next/server';
import mongoose from 'mongoose';
import { connectDB } from '@/lib/db';
import { captureException } from '@/lib/services/error-monitor';
import Order, { type PaymentMethod } from '@/lib/models/Order';
import Product from '@/lib/models/Product';
import Booking from '@/lib/models/Booking';
import Country from '@/lib/models/Country';
import { getAuthUser } from '@/lib/auth';
import { AppId, getUserModelByAppId } from '@/lib/auth/app-users';
import { generateToken } from '@/lib/services/jwt';
import { validateReferralCode } from '@/lib/services/referral-validation';
import { getClientCountry } from '@/lib/utils/ip';
import { countryNameToCode } from '@/lib/country-visibility';

const COUNTRY_HEADER_CANDIDATES = [
  'x-vercel-ip-country',
  'cf-ipcountry',
  'cloudfront-viewer-country',
  'x-country-code',
] as const;

function normalizeCountryCode(raw: string | null): string | null {
  if (!raw) return null;

  const code = raw.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return null;
  if (code === 'XX' || code === 'ZZ') return null;

  return code;
}
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
  normalizeEmail,
  normalizePhone,
  type PartialPaymentCreationLock,
} from '@/lib/services/partial-payment-guard';
import { validateCoupon } from '@/lib/services/coupon';
import { trackInitiateCheckout } from '@/lib/services/fb-capi';
import { uploadFileToR2 } from '@/lib/services/r2';
import { convertCurrency } from '@/lib/services/currency';
import {
  resolveUnitPriceWithVisibility,
  PAYMENT_GATEWAY_CURRENCIES,
} from '@/lib/services/price-resolver';
import { rateLimit, getClientIp } from '@/lib/rate-limit';
import { log } from '@/lib/request-logger';
import { parseJsonBody } from '@/lib/validation/http';
import { checkoutSchema } from '@/lib/validation/schemas';
import {
  refreshDefaultExecutionDateCache,
  skipBlockedDates,
} from '@/lib/execution-date';
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

function isDuplicateOrderNumberError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  const maybeError = error as Error & { code?: number };
  return maybeError.code === 11000 && error.message.includes('orderNumber_1');
}

function getPaymentAttemptNumber(order: { payments?: unknown[] }): number {
  return (order.payments?.length ?? 0) + 1;
}

type CheckoutAppUserDoc = mongoose.Document & {
  _id: mongoose.Types.ObjectId;
  email: string;
  name: string;
  password?: string;
  phone?: string;
  country?: string;
  appId?: string;
  isBanned?: boolean;
  ref?: string;
  detectedCountry?: string | null;
  comparePassword(candidatePassword: string): Promise<boolean>;
};

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
      ref,
      referralId,
      sizeIndex,
      paymentOption = 'full',
      customPaymentAmount,
      termsAgreed,
      reservationData,
      source,
      deviceFingerprint,
      accountPassword,
      isUpgrade,
      fromProductId,
      upgradeDiscount,
      recommendProductId,
      viewerCountryCode,
    } = body;

    const orderSource: 'manasik' | 'ghadaq' =
      source === 'ghadaq' ? 'ghadaq' : 'manasik';
    const checkoutAppId: Exclude<AppId, 'admin_panel'> =
      orderSource === 'ghadaq' ? 'ghadaq' : 'manasik';

    const locationCode = COUNTRY_HEADER_CANDIDATES.reduce<string | null>(
      (resolved, headerName) => {
        if (resolved) return resolved;
        return normalizeCountryCode(request.headers.get(headerName));
      },
      null,
    );

    const sessionUser = await getAuthUser(checkoutAppId);

    let tokenToSet: string | null = null;
    let effectiveUserId: string | null = sessionUser?.userId || null;

    const UserModel = getUserModelByAppId(
      checkoutAppId,
    ) as unknown as mongoose.Model<CheckoutAppUserDoc>;

    const normalizedInputEmail = normalizeEmail(billingData.email);
    const normalizedInputPhone = normalizePhone(billingData.phone);

    if (!normalizedInputEmail) {
      return NextResponse.json(
        { success: false, error: 'Invalid email', code: 'INVALID_EMAIL' },
        { status: 400 },
      );
    }

    if (!normalizedInputPhone) {
      return NextResponse.json(
        {
          success: false,
          error: 'Phone number is required',
          code: 'PHONE_REQUIRED',
        },
        { status: 400 },
      );
    }

    let resolvedBillingEmail = normalizedInputEmail;
    let resolvedBillingPhone = normalizedInputPhone;
    let resolvedBillingCountry = billingData.country?.trim() || '';
    let resolvedDetectedCountry: string | null = null;

    if (sessionUser) {
      const authenticatedUser = await UserModel.findById(sessionUser.userId)
        .select('name email phone country isBanned ref detectedCountry')
        .lean(false);

      if (!authenticatedUser) {
        return NextResponse.json(
          {
            success: false,
            error: 'Authentication required',
            code: 'AUTH_REQUIRED',
          },
          { status: 401 },
        );
      }

      if (!authenticatedUser.detectedCountry) {
        const country = getClientCountry(request);
        if (country) {
          authenticatedUser.detectedCountry = country;
          await authenticatedUser.save();
        }
      }
      resolvedDetectedCountry = authenticatedUser.detectedCountry || null;

      if (authenticatedUser.isBanned) {
        return NextResponse.json(
          {
            success: false,
            error:
              'Your account is restricted from placing new orders. You can still pay any remaining amount from order history.',
            code: 'ACCOUNT_ACTION_BLOCKED',
          },
          { status: 403 },
        );
      }

      effectiveUserId = authenticatedUser._id.toString();
      resolvedBillingEmail =
        normalizeEmail(authenticatedUser.email) || normalizedInputEmail;
      resolvedBillingPhone =
        normalizePhone(authenticatedUser.phone) || normalizedInputPhone;
      resolvedBillingCountry =
        authenticatedUser.country?.trim() || resolvedBillingCountry;

      if (!normalizePhone(authenticatedUser.phone) && normalizedInputPhone) {
        const existingPhone = await UserModel.findOne({
          phone: normalizedInputPhone,
          _id: { $ne: authenticatedUser._id },
        })
          .select('_id')
          .lean();

        if (existingPhone) {
          return NextResponse.json(
            {
              success: false,
              error: 'Phone number already used',
              code: 'PHONE_ALREADY_USED',
            },
            { status: 409 },
          );
        }

        authenticatedUser.phone = normalizedInputPhone;
        if (!authenticatedUser.country && resolvedBillingCountry) {
          authenticatedUser.country = resolvedBillingCountry;
        }
        await authenticatedUser.save();
        resolvedBillingPhone = normalizedInputPhone;
      }
    } else {
      const normalizedPassword =
        typeof accountPassword === 'string' ? accountPassword.trim() : '';

      if (normalizedPassword.length < 6) {
        return NextResponse.json(
          {
            success: false,
            error: 'Password is required to continue checkout',
            code: 'ACCOUNT_PASSWORD_REQUIRED',
          },
          { status: 400 },
        );
      }

      const existingEmailUser = await UserModel.findOne({
        email: normalizedInputEmail,
      })
        .select('+password detectedCountry')
        .lean(false);
      const existingPhoneUser = await UserModel.findOne({
        phone: normalizedInputPhone,
      })
        .select('+password')
        .lean(false);

      if (existingEmailUser) {
        if (existingEmailUser.isBanned) {
          return NextResponse.json(
            {
              success: false,
              error:
                'Your account is restricted from placing new orders. You can still pay any remaining amount from order history.',
              code: 'ACCOUNT_ACTION_BLOCKED',
            },
            { status: 403 },
          );
        }

        const isMatch =
          await existingEmailUser.comparePassword(normalizedPassword);
        if (!isMatch) {
          return NextResponse.json(
            {
              success: false,
              error: 'Email already used',
              code: 'EMAIL_ALREADY_USED',
            },
            { status: 409 },
          );
        }

        if (
          existingPhoneUser &&
          existingPhoneUser._id.toString() !== existingEmailUser._id.toString()
        ) {
          return NextResponse.json(
            {
              success: false,
              error: 'Phone number already used',
              code: 'PHONE_ALREADY_USED',
            },
            { status: 409 },
          );
        }

        if (!normalizePhone(existingEmailUser.phone) && normalizedInputPhone) {
          existingEmailUser.phone = normalizedInputPhone;
        }
        if (!existingEmailUser.country && resolvedBillingCountry) {
          existingEmailUser.country = resolvedBillingCountry;
        }
        if (!existingEmailUser.detectedCountry) {
          const country = getClientCountry(request);
          if (country) {
            existingEmailUser.detectedCountry = country;
          }
        }
        resolvedDetectedCountry = existingEmailUser.detectedCountry || null;
        await existingEmailUser.save();

        tokenToSet = generateToken({
          _id: existingEmailUser._id.toString(),
          appId: checkoutAppId,
          name: existingEmailUser.name,
          email: existingEmailUser.email,
        });
        effectiveUserId = existingEmailUser._id.toString();
        resolvedBillingEmail =
          normalizeEmail(existingEmailUser.email) || normalizedInputEmail;
        resolvedBillingPhone =
          normalizePhone(existingEmailUser.phone) || normalizedInputPhone;
        resolvedBillingCountry =
          existingEmailUser.country?.trim() || resolvedBillingCountry;
      } else {
        if (existingPhoneUser) {
          return NextResponse.json(
            {
              success: false,
              error: 'Phone number already used',
              code: 'PHONE_ALREADY_USED',
            },
            { status: 409 },
          );
        }

        const newUserPayload: {
          name: string;
          email: string;
          password: string;
          phone: string;
          country: string;
          appId: string;
          detectedCountry?: string;
          registerSource?: string;
        } = {
          name: billingData.fullName.trim(),
          email: normalizedInputEmail,
          password: normalizedPassword,
          phone: normalizedInputPhone,
          country: resolvedBillingCountry,
          appId: checkoutAppId,
          registerSource: 'checkout',
        };
        const country = getClientCountry(request);
        if (country) {
          newUserPayload.detectedCountry = country;
        }
        const newUser = await UserModel.create(newUserPayload);
        resolvedDetectedCountry =
          typeof newUser.detectedCountry === 'string'
            ? newUser.detectedCountry
            : null;

        tokenToSet = generateToken({
          _id: newUser._id.toString(),
          appId: checkoutAppId,
          name: newUser.name,
          email: newUser.email,
        });
        effectiveUserId = newUser._id.toString();
        resolvedBillingEmail =
          normalizeEmail(newUser.email) || normalizedInputEmail;
        resolvedBillingPhone =
          normalizePhone(newUser.phone) || normalizedInputPhone;
        resolvedBillingCountry =
          newUser.country?.trim() || resolvedBillingCountry;
      }
    }

    if (!effectiveUserId) {
      return NextResponse.json(
        {
          success: false,
          error: 'Checkout requires an account',
          code: 'ACCOUNT_REQUIRED',
        },
        { status: 401 },
      );
    }

    let resolvedRef: string | undefined;
    const incomingReferralId = referralId ?? ref ?? null;
    const referralValidation = await validateReferralCode(incomingReferralId);
    if (referralValidation.valid) {
      resolvedRef = incomingReferralId?.trim() || undefined;
    }

    if (!resolvedRef) {
      resolvedRef = checkoutAppId === 'ghadaq' ? 'GHD-D' : 'MNK-D';
    }

    const finalUserDoc = await UserModel.findById(effectiveUserId)
      .select('ref detectedCountry')
      .lean(false);
    if (finalUserDoc) {
      if (typeof finalUserDoc.detectedCountry === 'string' && finalUserDoc.detectedCountry) {
        resolvedDetectedCountry = finalUserDoc.detectedCountry;
      }
      if (finalUserDoc.ref) {
        resolvedRef = finalUserDoc.ref;
      } else {
        finalUserDoc.ref = resolvedRef;
        await finalUserDoc.save();
      }
    }

    // Normalize resolvedDetectedCountry to a 2-letter code.
    // The DB's detectedCountry field may store full country names (e.g.
    // "Saudi Arabia") from older records — convert them to ISO codes.
    // If normalization fails, fall back to the viewerCountryCode sent by
    // the frontend (from the currency provider's homeCountryCode).
    if (resolvedDetectedCountry) {
      const normalized = countryNameToCode(resolvedDetectedCountry);
      if (normalized) {
        resolvedDetectedCountry = normalized;
      } else if (viewerCountryCode) {
        resolvedDetectedCountry = viewerCountryCode;
      }
    } else if (viewerCountryCode) {
      resolvedDetectedCountry = viewerCountryCode;
    }

    // Outstanding balance check removed - users can now pay for new orders
    // while having remaining balance. The UI popup serves as a reminder only.
    // const outstandingBalanceLock = await getOutstandingBalanceLock({
    //   source: orderSource,
    //   userId: effectiveUserId,
    //   email: resolvedBillingEmail,
    // });

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

    // Fetch all countries for price visibility resolution
    const allCountries = await Country.find({}).lean();

    if (!product.inStock) {
      return NextResponse.json(
        { success: false, error: 'Product is out of stock' },
        { status: 400 },
      );
    }

    if (!product.isActive) {
      return NextResponse.json(
        { success: false, error: 'Product is unavailable' },
        { status: 400 },
      );
    }

    let recommendedProduct = null;
    let recommendedProductPrice = 0;

    if (recommendProductId) {
      recommendedProduct = await Product.findOne({
        _id: recommendProductId,
        isDeleted: { $ne: true },
        isActive: true,
      });

      if (!recommendedProduct) {
        return NextResponse.json(
          {
            success: false,
            error: 'Recommended product not found or unavailable',
          },
          { status: 404 },
        );
      }

      const recSize = recommendedProduct.sizes[0];
      if (recSize && recSize.isAvailable !== false) {
        try {
          recommendedProductPrice = await resolveUnitPriceWithVisibility(
            recSize,
            recommendedProduct.baseCurrency || 'SAR',
            currency.toUpperCase(),
            resolvedDetectedCountry || '',
            allCountries,
          );
        } catch {
          // If exchange rate conversion fails, skip the recommended product
          recommendedProductPrice = 0;
        }
      }
    }

    let defaultExecutionDate = await refreshDefaultExecutionDateCache();
    const booking = await Booking.findOne({ key: 'global' }).lean();
    const blockedExecutionDates = new Set(
      (booking?.blockedExecutionDates ?? []).filter((value: string) =>
        /^\d{4}-\d{2}-\d{2}$/.test(value),
      ),
    );

    // Defensive: if the cached default is somehow still blocked, skip forward
    // and update the DB so the next order also gets the corrected date.
    if (blockedExecutionDates.has(defaultExecutionDate)) {
      defaultExecutionDate = skipBlockedDates(defaultExecutionDate, blockedExecutionDates);
      await Booking.updateOne(
        { key: 'global' },
        { $set: { defaultExecutionDate } },
      );
    }

    // Validate reservation answers against product reservation field config
    const reservationInput = Array.isArray(reservationData)
      ? reservationData
      : [];

    // ── Single source of truth: resolve execution date FIRST ──
    const userExecutionDate = reservationInput.find(
      (r): r is { key: string; value: string } =>
        typeof r === 'object' && r !== null && r.key === 'executionDate',
    )?.value;

    let resolvedExecutionDate = defaultExecutionDate;

    if (typeof userExecutionDate === 'string' && userExecutionDate.trim()) {
      const trimmed = userExecutionDate.trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
        return NextResponse.json(
          { success: false, error: 'Execution date format is invalid' },
          { status: 400 },
        );
      }
      if (trimmed < defaultExecutionDate) {
        return NextResponse.json(
          {
            success: false,
            error: `Execution date must be on or after ${defaultExecutionDate}`,
          },
          { status: 400 },
        );
      }
      if (blockedExecutionDates.has(trimmed)) {
        return NextResponse.json(
          { success: false, error: 'Execution date is not available' },
          { status: 400 },
        );
      }
      resolvedExecutionDate = trimmed;
    }

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

    let hasExecutionDateField = false;

    for (const field of normalizedReservationData) {
      let finalValue = field.value;

      if (field.key === 'executionDate') {
        hasExecutionDateField = true;
        // Override with the already-validated resolved execution date
        finalValue = resolvedExecutionDate;
      }

      if (field.required && !finalValue) {
        return NextResponse.json(
          {
            success: false,
            error: 'Missing required reservation field',
          },
          { status: 400 },
        );
      }

      if (!finalValue) continue;

      if (
        (field.type === 'text' || field.type === 'textarea') &&
        field.maxLength &&
        finalValue.length > field.maxLength
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
            opt.ar === finalValue || opt.en === finalValue,
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
        // New multi-image format: JSON-stringified array of data URLs / HTTP URLs.
        // Legacy format: single data URL / HTTP URL string.
        let imageValues: string[] = [];
        try {
          const parsed = JSON.parse(finalValue);
          if (Array.isArray(parsed)) {
            imageValues = parsed.filter(
              (v): v is string => typeof v === 'string' && v.length > 0,
            );
          }
        } catch {
          // Not JSON — treat as a single image (legacy)
          if (typeof finalValue === 'string' && finalValue.length > 0) {
            imageValues = [finalValue];
          }
        }

        if (imageValues.length === 0) {
          return NextResponse.json(
            {
              success: false,
              error: 'Invalid reservation picture format',
            },
            { status: 400 },
          );
        }

        // Cap at 4 images for safety
        imageValues = imageValues.slice(0, 4);

        const uploadedUrls: string[] = [];
        for (const imageValue of imageValues) {
          const isDataImage = imageValue.startsWith('data:image/');
          const isHttpUrl = /^https?:\/\//i.test(imageValue);

          if (!isDataImage && !isHttpUrl) {
            return NextResponse.json(
              {
                success: false,
                error: 'Invalid reservation picture format',
              },
              { status: 400 },
            );
          }

          if (isDataImage) {
            const [header, base64Data] = imageValue.split(',');
            const mimeType =
              header.match(/data:(.*?);base64/)?.[1] || 'image/png';
            const imageBuffer = Buffer.from(base64Data || '', 'base64');
            // Derive the file extension from the MIME type so the stored
            // object has a proper extension (e.g. .jpg, .png, .webp).
            // Without this, the R2 key has no extension which breaks
            // content-type detection and CDN caching.
            const ext =
              mimeType === 'image/jpeg' || mimeType === 'image/jpg'
                ? 'jpg'
                : mimeType === 'image/png'
                  ? 'png'
                  : mimeType === 'image/webp'
                    ? 'webp'
                    : mimeType === 'image/gif'
                      ? 'gif'
                      : 'jpg';
            const uploaded = await uploadFileToR2(
              new File([imageBuffer], `reservation-picture.${ext}`, {
                type: mimeType,
              }),
              'images/customers',
              `reservation-picture.${ext}`,
            );
            uploadedUrls.push(uploaded.url);
          } else {
            uploadedUrls.push(imageValue);
          }
        }

        finalValue = JSON.stringify(uploadedUrls);
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

    // ── Guarantee executionDate exists on EVERY order ──
    if (!hasExecutionDateField) {
      reservationAnswers.push({
        key: 'executionDate',
        label: { ar: 'تاريخ التنفيذ', en: 'Execution Date' },
        type: 'date',
        value: resolvedExecutionDate,
      });
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
    if (selectedSize?.isAvailable === false) {
      return NextResponse.json(
        { success: false, error: 'Selected size is unavailable' },
        { status: 400 },
      );
    }
    let unitPrice: number;
    try {
      unitPrice = await resolveUnitPriceWithVisibility(
        selectedSize,
        product.baseCurrency || 'SAR',
        currencyUpper,
        resolvedDetectedCountry || '',
        allCountries,
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'Unknown error';
      return NextResponse.json(
        {
          success: false,
          error: `Unable to resolve product price in ${currencyUpper}: ${reason}`,
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

    let totalAmount = unitPrice * quantity + recommendedProductPrice;

    // Apply upgrade discount if applicable
    const upgradeDiscountPercent =
      isUpgrade && typeof upgradeDiscount === 'number' && upgradeDiscount > 0
        ? upgradeDiscount
        : 0;
    if (upgradeDiscountPercent > 0) {
      totalAmount = Math.round(
        totalAmount * (1 - upgradeDiscountPercent / 100),
      );
    }

    let couponDiscount = 0;
    let appliedCouponCode: string | undefined;
    let appliedCouponId: string | undefined;
    if (couponCode) {
      const couponResult = await validateCoupon(
        couponCode,
        totalAmount,
        currencyUpper,
        productId,
        resolvedDetectedCountry,
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
      if (product.supportsHalfPayment === false) {
        return NextResponse.json(
          {
            success: false,
            error: 'This product does not support half payment',
          },
          { status: 400 },
        );
      }

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
      email: resolvedBillingEmail,
      phone: resolvedBillingPhone,
      ip,
      fingerprint: deviceFingerprint,
    });

    // Reuse existing processing order if it matches the same checkout details
    // Avoid creating duplicate orders when a user clicks Buy multiple times
    // and an earlier payment session is still valid.
    try {
      const now = Date.now();
      const cashExpiryWindowMs = getEasykashCashExpiryHours() * 60 * 60 * 1000;

      const candidateProcessingOrders = await Order.find({
        source: orderSource,
        status: 'processing',
        userId: effectiveUserId,
        isPartialPayment: isPartialPayment,
        'items.0.productId': product._id.toString(),
      })
        .sort({ createdAt: -1 })
        .limit(10)
        .lean();

      for (const existing of candidateProcessingOrders) {
        // Basic checks: payment type, full amount, item details
        const existingPaymentType =
          existing.paymentType ||
          (existing.isPartialPayment ? 'partial' : 'full');
        if (existingPaymentType !== paymentType) continue;

        if (Number(existing.fullAmount ?? 0) !== Number(amountAfterDiscount))
          continue;

        const firstItem = (existing.items || [])[0] || {};
        if (Number(firstItem.sizeIndex) !== Number(activeSizeIndex)) continue;
        if (Number(firstItem.quantity || 1) !== Number(quantity || 1)) continue;

        const normalizedExistingEmail = normalizeEmail(
          existing.billingData?.email,
        );
        const normalizedExistingPhone = normalizePhone(
          existing.billingData?.phone,
        );
        const normalizedCurrentEmail =
          partialPaymentIdentity.normalizedEmail ||
          normalizeEmail(resolvedBillingEmail);
        const normalizedCurrentPhone = normalizePhone(resolvedBillingPhone);
        if (normalizedExistingEmail !== normalizedCurrentEmail) continue;
        if (normalizedExistingPhone !== normalizedCurrentPhone) continue;

        const couponMatches =
          (existing.couponCode || '') === (appliedCouponCode || '');
        if (!couponMatches) continue;

        // Reservation data deep-equality
        const existingReservation = JSON.stringify(
          existing.reservationData || [],
        );
        const currentReservation = JSON.stringify(reservationAnswers || []);
        if (existingReservation !== currentReservation) continue;

        const payments = Array.isArray(existing.payments)
          ? existing.payments
          : [];
        if (payments.length === 0) continue;

        const firstPayment = payments[0];
        if (
          !firstPayment ||
          !firstPayment.redirectUrl ||
          !firstPayment.expiresAt
        )
          continue;

        const expiresAt = new Date(firstPayment.expiresAt).getTime();
        const createdAt = firstPayment.createdAt
          ? new Date(firstPayment.createdAt).getTime()
          : 0;
        const isStillValid =
          expiresAt > now &&
          (createdAt === 0 || createdAt + cashExpiryWindowMs > now);
        if (!isStillValid) continue;

        // Reuse existing processing order
        const response = NextResponse.json({
          success: true,
          data: {
            order: {
              _id: existing._id,
              orderNumber: existing.orderNumber,
              totalAmount: existing.totalAmount,
              fullAmount: existing.fullAmount,
              remainingAmount: existing.isPartialPayment
                ? (existing.fullAmount || 0) - (existing.paidAmount || 0)
                : 0,
              isPartialPayment: !!existing.isPartialPayment,
              couponDiscount: existing.couponDiscount || 0,
              currency: existing.currency,
              status: existing.status,
            },
            checkoutUrl: firstPayment.redirectUrl,
            reused: true,
          },
        });

        if (tokenToSet) setAuthCookie(response, checkoutAppId, tokenToSet);
        return response;
      }
    } catch {
      // Log and continue creating a new order if reuse checks fail unexpectedly
      // (avoid blocking checkout flow on reuse logic issues)
    }

    if (paymentType === 'partial') {
      partialPaymentLock = await acquirePartialPaymentCreationLock({
        source: orderSource,
        userId: effectiveUserId,
        email: resolvedBillingEmail,
        phone: resolvedBillingPhone,
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
        email: resolvedBillingEmail,
        phone: resolvedBillingPhone,
        ip,
        fingerprint: deviceFingerprint,
      });

      if (!guardDecision.allowed) {
        await releasePartialPaymentLock(partialPaymentLock);
        partialPaymentLock = null;

        return NextResponse.json(
          {
            success: false,
            code:
              guardDecision.code ||
              guardDecision.reasonCode ||
              'ACTIVE_PARTIAL_ORDER',
            error:
              guardDecision.message ||
              'You already have an active partial payment order. Complete it before creating a new one.',
            blockingOrderNumber: guardDecision.blockingOrderNumber,
          },
          { status: 409 },
        );
      }
    }

    const orderItemsPayload = [
      {
        productId: product._id,
        productSlug: product.slug,
        productName: { ar: product.name.ar, en: product.name.en },
        price: unitPrice,
        currency: currencyUpper,
        quantity,
        sizeIndex: activeSizeIndex,
        sizeName: {
          ar: selectedSize?.name?.ar || '',
          en: selectedSize?.name?.en || '',
        },
        sizeDesignName: selectedSize?.designName || '',
      },
    ];

    if (recommendedProduct && recommendedProductPrice > 0) {
      const recSize = recommendedProduct.sizes[0];
      orderItemsPayload.push({
        productId: recommendedProduct._id,
        productSlug: recommendedProduct.slug,
        productName: {
          ar: recommendedProduct.name.ar,
          en: recommendedProduct.name.en,
        },
        price: recommendedProductPrice,
        currency: currencyUpper,
        quantity: 1, // Only 1 quantity for recommended product
        sizeIndex: 0,
        sizeName: {
          ar: recSize?.name?.ar || '',
          en: recSize?.name?.en || '',
        },
        sizeDesignName: recSize?.designName || '',
      });
    }

    const orderPayload = {
      items: orderItemsPayload,
      userId: effectiveUserId,
      isGuest: false,
      totalAmount: payAmount,
      fullAmount: amountAfterDiscount,
      paidAmount: 0,
      remainingAmount: amountAfterDiscount,
      isPartialPayment,
      paymentType,
      currency: currencyUpper,
      status: 'pending',
      billingData: {
        fullName: billingData.fullName,
        email: partialPaymentIdentity.normalizedEmail || resolvedBillingEmail,
        phone: resolvedBillingPhone,
        country: resolvedBillingCountry || 'N/A',
      },
      referralId: resolvedRef,
      couponCode: appliedCouponCode,
      couponId: appliedCouponId,
      couponDiscount,
      // Upgrade discount tracking
      isUpgrade: isUpgrade ?? false,
      fromProductId: fromProductId || undefined,
      upgradeDiscount:
        upgradeDiscountPercent > 0 ? upgradeDiscountPercent : undefined,
      termsAgreedAt: new Date(),
      reservationData: reservationAnswers,
      source: orderSource,
      latestClientIp: partialPaymentIdentity.normalizedIp,
      deviceFingerprint: partialPaymentIdentity.normalizedFingerprint,
      location: locationCode || undefined,
      locale,
      payments: [],
      paymentAttempts: [],
    };

    const maxOrderCreateRetries = 3;

    const createOrderWithRetries = async () => {
      for (let attempt = 1; attempt <= maxOrderCreateRetries; attempt += 1) {
        try {
          return await Order.create(orderPayload);
        } catch (orderCreateError) {
          if (
            isDuplicateOrderNumberError(orderCreateError) &&
            attempt < maxOrderCreateRetries
          ) {
            log('warn', 'checkout.order_number_collision_retry', {
              ip,
              traceId,
              source: orderSource,
              attempt,
            });
            continue;
          }

          throw orderCreateError;
        }
      }

      throw new Error('Failed to create order after retrying order number');
    };

    const order = await createOrderWithRetries();

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
        em: resolvedBillingEmail,
        ph: resolvedBillingPhone,
        fn: billingData.fullName.split(' ')[0],
        ln:
          billingData.fullName.split(' ').slice(1).join(' ') ||
          billingData.fullName.split(' ')[0],
        country: resolvedBillingCountry,
        client_ip_address: reqIp,
        client_user_agent: reqUa,
        external_id: order._id.toString(),
      },
    }).catch(() => { });

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

    let easykashAmount = payAmount;
    let paymentCurrency = currencyUpper;

    if (!PAYMENT_GATEWAY_CURRENCIES.includes(currencyUpper as (typeof PAYMENT_GATEWAY_CURRENCIES)[number])) {
      try {
        const convertedAmount = await convertCurrency(
          payAmount,
          currencyUpper,
          'EGP',
        );

        if (!Number.isFinite(convertedAmount) || convertedAmount <= 0) {
          throw new Error('Converted amount is invalid');
        }

        easykashAmount = Math.ceil(convertedAmount);
        paymentCurrency = 'EGP';
      } catch (conversionError) {
        const egpPriceEntry = selectedSize.prices?.find(
          (p: { currencyCode: string; amount: number }) =>
            p.currencyCode === 'EGP',
        );

        if (
          typeof egpPriceEntry?.amount !== 'number' ||
          egpPriceEntry.amount <= 0
        ) {
          await Order.findByIdAndDelete(order._id);
          const reason =
            conversionError instanceof Error
              ? conversionError.message
              : 'Unknown conversion error';

          return NextResponse.json(
            {
              success: false,
              error: `Unable to convert ${currencyUpper} amount to EGP and no EGP product price is configured. (${reason})`,
            },
            { status: 500 },
          );
        }

        const egpUnitPrice = egpPriceEntry.amount;
        const egpTotal = egpUnitPrice * quantity;
        const couponRatio = totalAmount > 0 ? couponDiscount / totalAmount : 0;
        const egpAfterDiscount = egpTotal - egpTotal * couponRatio;
        const payRatio =
          amountAfterDiscount > 0 ? payAmount / amountAfterDiscount : 1;

        easykashAmount = Math.ceil(egpAfterDiscount * payRatio);
        paymentCurrency = 'EGP';

        const reason =
          conversionError instanceof Error
            ? conversionError.message
            : 'Unknown conversion error';
        log('warn', 'checkout.currency_conversion_fallback_to_db_egp', {
          ip,
          traceId,
          orderNumber: order.orderNumber,
          fromCurrency: currencyUpper,
          toCurrency: 'EGP',
          reason,
          fallbackEgpAmount: easykashAmount,
        });
      }
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
    const initialPaymentAttemptNum = getPaymentAttemptNumber(order);
    const paymentId = generatePaymentId();

    const cashExpiryHours = getEasykashCashExpiryHours();
    let easykashResponse: Awaited<ReturnType<typeof createPayment>> | null =
      null;
    let easykashOrderId: string | null = null;

    const existingReferences = new Set(
      (order.payments ?? []).map((payment) => payment.easykashOrderId),
    );
    let paymentAttemptNum = initialPaymentAttemptNum;
    const maxReferenceRetries = 5;

    try {
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
            name: billingData.fullName,
            email: resolvedBillingEmail,
            mobile: resolvedBillingPhone,
            cashExpiry: cashExpiryHours,
            redirectUrl: `${baseUrl}/payment/status?orderNumber=${order.orderNumber}`,
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
        throw new Error(
          'Unable to allocate a unique EasyKash customerReference',
        );
      }
    } catch (easykashError) {
      // Clean up the orphaned order so it doesn't block future attempts
      await Order.findByIdAndDelete(order._id);
      captureException(easykashError, {
        service: 'Checkout',
        operation: 'createPayment_EasyKash',
        severity: 'high',
        metadata: {
          easykashOrderId:
            easykashOrderId ||
            `${order.orderNumber}-P${initialPaymentAttemptNum}`,
          orderNumber: order.orderNumber,
        },
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
        orderAmount: payAmount,
        gatewayAmount: easykashAmount,
        gatewayCurrency: paymentCurrency,
        amount: payAmount,
        currency: currencyUpper,
        status: 'pending',
        paymentMethod: 'easykash' as PaymentMethod,
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
