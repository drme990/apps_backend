import { NextRequest, NextResponse } from 'next/server';
import mongoose from 'mongoose';
import { connectDB } from '@/lib/db';
import { captureException } from '@/lib/services/error-monitor';
import { normalizeCurrencyCode } from '@/lib/currencies';
import Order, {
  type IOrder,
  type IOrderItem,
} from '@/lib/models/Order';
import Product from '@/lib/models/Product';
import Booking from '@/lib/models/Booking';
import { getAuthUser } from '@/lib/auth';
import { AppId, getUserModelByAppId } from '@/lib/auth/app-users';
import { generateToken } from '@/lib/services/jwt';
import { validateReferralCode } from '@/lib/services/referral-validation';
import { getClientCountry } from '@/lib/utils/ip';
import { countryNameToCode, normalizeCountryName } from '@/lib/country-visibility';

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

  // Map Israel → Palestine everywhere in the app.
  return code === 'IL' ? 'PS' : code;
}
import {
  findReservationInputByField,
  matchReservationOption,
  normalizeReservationFields,
} from '@/lib/reservation-fields';
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
import { uploadFileToR2, compressImageBuffer } from '@/lib/services/r2';
import {
  findActiveShareCampaign,
  getSharesForSize,
} from '@/lib/services/share-campaign';
import {
  attachEasykashPayment,
  buildCheckoutBasketFingerprint,
  buildCheckoutFingerprint,
  buildCheckoutIdentity,
  buildOpenCheckoutKey,
  CHECKOUT_REUSE_WINDOW_MS,
  expirePendingPayments,
  findLivePendingPayment,
  GatewayPaymentError,
  OPEN_CHECKOUT_STATUSES,
  type CheckoutAction,
} from '@/lib/services/checkout-reuse';
import { createStorefrontPriceResolver } from '@/lib/services/price-resolver';
import { rateLimit, getClientIp } from '@/lib/rate-limit';
import { log } from '@/lib/request-logger';
import { parseJsonBody } from '@/lib/validation/http';
import { checkoutSchema } from '@/lib/validation/schemas';
import {
  refreshDefaultExecutionDateCache,
  skipBlockedDates,
} from '@/lib/execution-date';

function isDuplicateOrderNumberError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  const maybeError = error as Error & { code?: number };
  return maybeError.code === 11000 && error.message.includes('orderNumber_1');
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
  termsAgreedAt?: Date;
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

/**
 * Upload deferred reservation pictures to R2 and swap the answers'
 * values for the resulting URL arrays. Called only on the `created` /
 * `updated` paths — reused/revived orders keep their stored URLs.
 */
async function materializeReservationPictures(
  answers: Array<{ value: string }>,
  pending: Array<{ answerIndex: number; imageValues: string[] }>,
): Promise<void> {
  for (const upload of pending) {
    const uploadedUrls: string[] = [];
    for (const imageValue of upload.imageValues) {
      if (!imageValue.startsWith('data:image/')) {
        // HTTP URL passthrough — already hosted.
        uploadedUrls.push(imageValue);
        continue;
      }

      const [header, base64Data] = imageValue.split(',');
      const mimeType = header.match(/data:(.*?);base64/)?.[1] || 'image/png';
      const rawBuffer = Buffer.from(base64Data || '', 'base64');

      // Server-side compression (defense-in-depth, even if the frontend
      // already compressed the image). Max 1920px, JPEG q80, <500KB.
      let imageBuffer: Uint8Array = rawBuffer;
      let outputMimeType = mimeType;
      try {
        const compressed = await compressImageBuffer(rawBuffer, mimeType);
        imageBuffer = compressed.buffer;
        outputMimeType = compressed.mimeType;
      } catch {
        // Compression failed — use the raw buffer (best-effort)
      }

      // Stored under `Website Images/customers/` — the order number
      // isn't known yet at this point in the checkout flow.
      const blobPart = imageBuffer as unknown as BlobPart;
      const uploaded = await uploadFileToR2(
        new File([blobPart], 'reservation-picture.jpg', {
          type: outputMimeType,
        }),
        'Website Images/customers',
        'reservation-picture.jpg',
      );
      uploadedUrls.push(uploaded.url);
    }

    if (answers[upload.answerIndex]) {
      answers[upload.answerIndex].value = JSON.stringify(uploadedUrls);
    }
  }

  // Drain the queue — if a caller retries after a partial failure, the
  // already-materialized entries must not re-upload (orphan files).
  pending.length = 0;
}

export async function POST(request: NextRequest) {
  let partialPaymentLock: PartialPaymentCreationLock | null = null;

  try {
    // Rate limit: 10 checkout attempts per IP per minute
    const ip = getClientIp(request);
    const traceId = request.headers.get('x-request-id') ?? undefined;
    const rl = rateLimit(`checkout:${ip}`, 10, 60_000);
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
      currency: rawCurrency,
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
      selectedAddOns,
      attribution,
      initiateCheckoutEventId,
    } = body;

    // Normalize currency to ISO 4217 code (handles localized symbols like "ج.م" → "EGP")
    const currency = normalizeCurrencyCode(rawCurrency);

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
    let resolvedBillingCountry = normalizeCountryName(billingData.country);
    let resolvedDetectedCountry: string | null = null;

    if (sessionUser) {
      const authenticatedUser = await UserModel.findById(sessionUser.userId)
        .select('name email phone country isBanned ref detectedCountry termsAgreedAt')
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

      // Set termsAgreedAt on the existing user if not already set
      if (!authenticatedUser.termsAgreedAt) {
        authenticatedUser.termsAgreedAt = new Date();
        await authenticatedUser.save();
      }

      if (!authenticatedUser.detectedCountry) {
        const country = getClientCountry(request);
        if (country) {
          authenticatedUser.detectedCountry = normalizeCountryName(country);
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
        normalizeCountryName(authenticatedUser.country) || resolvedBillingCountry;

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
            existingEmailUser.detectedCountry = normalizeCountryName(country);
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
          normalizeCountryName(existingEmailUser.country) || resolvedBillingCountry;
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
          termsAgreedAt?: Date;
        } = {
          name: billingData.fullName.trim(),
          email: normalizedInputEmail,
          password: normalizedPassword,
          phone: normalizedInputPhone,
          country: resolvedBillingCountry,
          appId: checkoutAppId,
          registerSource: 'checkout',
          termsAgreedAt: new Date(),
        };
        const country = getClientCountry(request);
        if (country) {
          newUserPayload.detectedCountry = normalizeCountryName(country);
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
          normalizeCountryName(newUser.country) || resolvedBillingCountry;
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
    const referralValidation = await validateReferralCode(incomingReferralId, checkoutAppId);
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

    // Determine the viewer country for price resolution.
    //
    // PRIORITY (matches the currency provider's order):
    //   a. DB detectedCountry (already set in resolvedDetectedCountry for
    //      logged-in users — the currency provider overwrites the cookie
    //      with this value, so the product page and checkout stay
    //      consistent)
    //   b. viewerCountryCode from the request body (from the cookie — set
    //      by IP/geolocation detection for guests)
    //   c. IP headers (cf-ipcountry / x-vercel-ip-country)
    //   d. 'OT' (Other) — final fallback when no country can be detected
    //
    // 'OT' (Other) is used when no country can be detected — the user sees
    // all currencies with real prices, no exchange conversion.

    // If the DB didn't provide a detectedCountry (guest user, or DB field
    // is empty), fall back to the viewerCountryCode from the request body.
    if (!resolvedDetectedCountry && viewerCountryCode) {
      resolvedDetectedCountry = normalizeCountryCode(viewerCountryCode) || '';
    }

    // Normalize resolvedDetectedCountry to a 2-letter code.
    // The DB's detectedCountry field may store full country names (e.g.
    // "Saudi Arabia") from older records — convert them to ISO codes.
    if (resolvedDetectedCountry) {
      const normalized = countryNameToCode(resolvedDetectedCountry);
      if (normalized) {
        resolvedDetectedCountry = normalized;
      } else {
        // If normalization fails, try IP headers as a last resort.
        const ipCountry = getClientCountry(request);
        resolvedDetectedCountry = normalizeCountryCode(ipCountry) || 'OT';
      }
    } else {
      // No detected country at all — try IP headers, then 'OT'.
      const ipCountry = getClientCountry(request);
      resolvedDetectedCountry = normalizeCountryCode(ipCountry) || 'OT';
    }

    // Strict billing gate — an order must never be persisted without a
    // complete customer identity. Resolved fields can come from the
    // request or the authenticated user's profile, so verify the final
    // resolved values rather than the raw input.
    if (
      !billingData.fullName.trim() ||
      !resolvedBillingEmail ||
      !resolvedBillingPhone ||
      !resolvedBillingCountry
    ) {
      log('warn', 'checkout.missing_billing_data', {
        ip,
        traceId,
        source: orderSource,
        userId: effectiveUserId,
        hasEmail: Boolean(resolvedBillingEmail),
        hasPhone: Boolean(resolvedBillingPhone),
        hasCountry: Boolean(resolvedBillingCountry),
      });
      return NextResponse.json(
        {
          success: false,
          error:
            'Complete billing information is required (name, email, phone, country)',
          code: 'MISSING_BILLING_DATA',
        },
        { status: 400 },
      );
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

    // Single price resolver bound to the viewer — loads the same
    // country set the display path uses, so the charged amount always
    // matches the price the user saw on the product/checkout pages.
    const priceResolver = createStorefrontPriceResolver(
      resolvedDetectedCountry || '',
    );

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
          recommendedProductPrice = await priceResolver.unitPrice(
            recSize,
            recommendedProduct.baseCurrency || 'SAR',
            currency.toUpperCase(),
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

    // Picture uploads are deferred until after the reuse decision —
    // `reused`/`revived` orders already hold valid R2 URLs.
    const pendingPictureUploads: Array<{
      answerIndex: number;
      imageValues: string[];
    }> = [];

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
        }

        // Uploads are DEFERRED until after the reuse decision
        // (enhance-order-createing.md §3.1) — `reused`/`revived` paths
        // never touch R2. The answer keeps the raw client values for
        // now; materializeReservationPictures() swaps them for uploaded
        // URLs only when the order is actually written.
        finalValue = JSON.stringify(imageValues);
        pendingPictureUploads.push({ answerIndex: reservationAnswers.length, imageValues });
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
      unitPrice = await priceResolver.unitPrice(
        selectedSize,
        product.baseCurrency || 'SAR',
        currencyUpper,
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'Unknown error';
      captureException(err, {
        service: 'Checkout',
        operation: 'resolveUnitPrice',
        severity: 'medium',
      });
      return NextResponse.json(
        {
          success: false,
          error: `Unable to resolve product price in ${currencyUpper}: ${reason}`,
        },
        { status: 400 },
      );
    }

    if (unitPrice <= 0) {
      console.error(`[checkout.unitPriceZero] Product price is not configured for ${currencyUpper}`, {
        productId: product._id?.toString(),
        sizeIndex: activeSizeIndex,
      });
      return NextResponse.json(
        {
          success: false,
          error: `Product price is not configured for ${currencyUpper}`,
        },
        { status: 400 },
      );
    }

    // Log the resolved unit price for debugging price discrepancies.
    if (process.env.PRICE_DEBUG === '1' || process.env.PRICE_DEBUG === 'true') {
      console.log('[checkout.priceResolution]', {
        productId: product._id?.toString(),
        sizeIndex: activeSizeIndex,
        currency: currencyUpper,
        backendUnitPrice: unitPrice,
        viewerCountryCode: resolvedDetectedCountry,
        baseCurrency: product.baseCurrency,
      });
    }

    let totalAmount = unitPrice * quantity + recommendedProductPrice;

    // ── Resolve selected add-ons ────────────────────────────────────────
    // Add-ons are optional extras the customer selected on the product page.
    // Each becomes a separate order item with isAddOn: true.
    const resolvedAddOns: Array<{
      addOn: NonNullable<typeof product.addOns>[number];
      quantity: number;
      price: number;
    }> = [];

    if (selectedAddOns && selectedAddOns.length > 0 && product.addOns?.length) {
      // Enforce single-select: only the first selected add-on is used.
      const effectiveSelected =
        product.addOnSelectionMode === 'single'
          ? selectedAddOns.slice(0, 1)
          : selectedAddOns;

      for (const sel of effectiveSelected) {
        const addOn = product.addOns.find(
          (a) => a._id?.toString() === sel.addOnId,
        );
        if (!addOn) continue;
        if (addOn.isAvailable === false) continue;

        let addOnPrice: number;
        try {
          addOnPrice = await priceResolver.unitPrice(
            { prices: addOn.prices },
            product.baseCurrency || 'SAR',
            currencyUpper,
          );
        } catch {
          continue; // skip add-ons that can't be priced in this currency
        }

        if (addOnPrice <= 0) continue;

        const addOnQty = sel.quantity || 1;
        resolvedAddOns.push({ addOn, quantity: addOnQty, price: addOnPrice });
        totalAmount += addOnPrice * addOnQty;
      }
    }

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

    // ── Order items payload (pure computation — needed by both the
    //    create and update-in-place paths) ──
    const orderItemsPayload: IOrderItem[] = [
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
        quantity: 1,
        sizeIndex: 0,
        sizeName: {
          ar: recSize?.name?.ar || '',
          en: recSize?.name?.en || '',
        },
        sizeDesignName: recSize?.designName || '',
      });
    }

    for (const { addOn, quantity: addOnQty, price: addOnPrice } of resolvedAddOns) {
      orderItemsPayload.push({
        productId: product._id,
        productSlug: product.slug,
        productName: { ar: addOn.name.ar, en: addOn.name.en },
        price: addOnPrice,
        currency: currencyUpper,
        quantity: addOnQty,
        isAddOn: true,
        parentItemIndex: 0,
      });
    }

    // ── Checkout reuse matrix (enhance-order-createing.md §3) ──
    // One customer + one basket = one live unpaid order. The unique
    // openCheckoutKey makes concurrent double-creates impossible, and
    // because it embeds the basket fingerprint, ANY product change
    // (product, size, quantity, add-ons, recommended product) lands on
    // a different slot → brand-new order; the old order's payment
    // timeline is never touched.
    const checkoutIdentity = buildCheckoutIdentity({
      source: orderSource,
      userId: effectiveUserId,
      email: resolvedBillingEmail,
      phone: resolvedBillingPhone,
    });
    const basketItems = [
      {
        productId: product._id.toString(),
        sizeIndex: activeSizeIndex,
        quantity,
      },
      ...(recommendedProduct && recommendedProductPrice > 0
        ? [
          {
            productId: recommendedProduct._id.toString(),
            sizeIndex: 0,
            quantity: 1,
          },
        ]
        : []),
      ...resolvedAddOns.map(({ addOn, quantity: addOnQty }) => ({
        productId: `addon:${addOn._id?.toString() ?? addOn.name.en}`,
        sizeIndex: 0,
        quantity: addOnQty,
        isAddOn: true,
      })),
    ];
    const openCheckoutKey = buildOpenCheckoutKey(
      checkoutIdentity,
      buildCheckoutBasketFingerprint(
        basketItems,
        isUpgrade && fromProductId ? String(fromProductId) : undefined,
      ),
    );
    const checkoutFingerprint = buildCheckoutFingerprint({
      source: orderSource,
      userId: effectiveUserId,
      email: resolvedBillingEmail,
      phone: resolvedBillingPhone,
      fullName: billingData.fullName,
      country: resolvedBillingCountry,
      items: basketItems,
      reservationAnswers,
      paymentType,
      fullAmount: amountAfterDiscount,
      payAmount,
      currency: currencyUpper,
      couponCode: appliedCouponCode,
    });

    const buildCheckoutResponse = (
      order: {
        _id: unknown;
        orderNumber: string;
        totalAmount?: number;
        fullAmount?: number;
        remainingAmount?: number;
        isPartialPayment?: boolean;
        couponDiscount?: number;
        currency?: string;
        status?: string;
      },
      checkoutUrl: string | null,
      checkoutAction: CheckoutAction,
      extra?: Record<string, unknown>,
    ) =>
      NextResponse.json({
        success: true,
        data: {
          order: {
            _id: order._id,
            orderNumber: order.orderNumber,
            totalAmount: order.totalAmount,
            fullAmount: order.fullAmount,
            remainingAmount: order.isPartialPayment
              ? order.remainingAmount ??
              ((order.fullAmount || 0) -
                ((order as { paidAmount?: number }).paidAmount ?? 0))
              : 0,
            isPartialPayment: !!order.isPartialPayment,
            couponDiscount: order.couponDiscount || 0,
            currency: order.currency,
            status: order.status,
          },
          checkoutUrl,
          checkoutAction,
          // Back-compat: frontends read `reused` today.
          reused: checkoutAction === 'reused',
          ...extra,
        },
      });

    /** Re-run share-campaign tagging after items are (re)built. */
    const retagShareCampaign = async (
      orderId: mongoose.Types.ObjectId | string,
    ) => {
      const anyCampaign = await findActiveShareCampaign(product._id);
      if (!anyCampaign) return;

      const sharesPerPurchase = getSharesForSize(anyCampaign, activeSizeIndex);
      if (sharesPerPurchase <= 0) return;

      const totalShares = sharesPerPurchase * quantity;
      const bestFitCampaign = await findActiveShareCampaign(
        product._id,
        totalShares,
      );
      const campaignToUse = bestFitCampaign || anyCampaign;
      const campaignId = String(campaignToUse._id);

      await Order.updateOne(
        {
          _id: String(orderId),
          items: {
            $elemMatch: {
              productId: new mongoose.Types.ObjectId(String(product._id)),
              sizeIndex: Number(activeSizeIndex),
              isAddOn: { $ne: true },
            },
          },
        },
        {
          $set: {
            'items.$.isShare': true,
            'items.$.shareCampaignId': new mongoose.Types.ObjectId(campaignId),
            'items.$.shareQuantity': totalShares,
          },
        },
      );
    };

    /**
     * Run the reuse decision tree against an open unpaid order found via
     * its openCheckoutKey. Returns a response, or null when the caller
     * should fall through to creating a new order.
     */
    const decideExistingCheckout = async (
      existing: mongoose.HydratedDocument<IOrder>,
    ): Promise<NextResponse | null> => {
      if (existing.checkoutFingerprint === checkoutFingerprint) {
        const livePayment = findLivePendingPayment(existing);
        if (livePayment?.redirectUrl) {
          log('info', 'checkout.reused', {
            ip,
            traceId,
            orderNumber: existing.orderNumber,
          });
          return buildCheckoutResponse(
            existing,
            livePayment.redirectUrl,
            'reused',
          );
        }

        // Same inputs, dead/missing link → append the next payment on
        // the SAME order. Pending-but-dead entries expire first.
        expirePendingPayments(existing);
        try {
          const attached = await attachEasykashPayment({
            order: existing,
            orderAmount: payAmount,
            orderCurrency: currencyUpper,
            customerName: billingData.fullName,
            customerEmail: resolvedBillingEmail,
            customerPhone: resolvedBillingPhone,
            ip,
            userId: effectiveUserId,
          });
          existing.status = 'processing';
          await existing.save();

          log('info', 'checkout.revived', {
            ip,
            traceId,
            orderNumber: existing.orderNumber,
          });
          return buildCheckoutResponse(
            existing,
            attached.redirectUrl,
            'revived',
          );
        } catch (gatewayError) {
          existing.status = 'failed';
          existing.internalNotes = [
            ...(existing.internalNotes ?? []),
            {
              text: `Gateway payment creation failed on revive: ${gatewayError instanceof Error ? gatewayError.message : 'unknown'}`,
              author: 'system',
              createdAt: new Date(),
            },
          ];
          await existing.save().catch(() => { });
          throw gatewayError;
        }
      }

      // Fingerprint differs, same customer + same basket (the slot key
      // matched, so items are identical) → UPDATE IN PLACE. A changed
      // basket never reaches here — it mints a new order instead.
      // Never mutate an order with money or a state we can't touch —
      // the candidate predicate already guarantees that, but re-check
      // for defense against a race between lookup and write.
      if (
        !OPEN_CHECKOUT_STATUSES.includes(existing.status) ||
        (existing.paidAmount ?? 0) > 0
      ) {
        return null;
      }

      // Deferred picture uploads happen now — the update needs real URLs.
      await materializeReservationPictures(
        reservationAnswers,
        pendingPictureUploads,
      );

      // Expire every pending payment BEFORE rewriting amounts — a stale
      // gateway link must never pay against new totals (§3.4).
      expirePendingPayments(existing);

      existing.items = orderItemsPayload;
      existing.reservationData = reservationAnswers;
      existing.totalAmount = payAmount;
      existing.fullAmount = amountAfterDiscount;
      existing.isPartialPayment = isPartialPayment;
      existing.paymentType = paymentType;
      existing.currency = currencyUpper;
      existing.billingData = {
        fullName: billingData.fullName,
        email: partialPaymentIdentity.normalizedEmail || resolvedBillingEmail,
        phone: resolvedBillingPhone,
        country: resolvedBillingCountry,
      };
      existing.couponCode = appliedCouponCode;
      existing.couponId = appliedCouponId;
      existing.couponDiscount = couponDiscount;
      existing.isUpgrade = isUpgrade ?? false;
      existing.fromProductId = fromProductId || undefined;
      existing.upgradeDiscount =
        upgradeDiscountPercent > 0 ? upgradeDiscountPercent : undefined;
      existing.latestClientIp = partialPaymentIdentity.normalizedIp;
      existing.deviceFingerprint = partialPaymentIdentity.normalizedFingerprint;
      existing.location = normalizeCountryName(locationCode) || undefined;
      existing.locale = locale;
      existing.checkoutFingerprint = checkoutFingerprint;
      existing.checkoutRevision = (existing.checkoutRevision ?? 0) + 1;
      // Kept untouched: orderNumber, orderCreatedAt/createdAt,
      // referralId, attribution (first-touch wins — §3.3).

      try {
        const attached = await attachEasykashPayment({
          order: existing,
          orderAmount: payAmount,
          orderCurrency: currencyUpper,
          customerName: billingData.fullName,
          customerEmail: resolvedBillingEmail,
          customerPhone: resolvedBillingPhone,
          ip,
          userId: effectiveUserId,
        });
        existing.status = 'processing';
        await existing.save();
        await retagShareCampaign(existing._id);

        log('info', 'checkout.updated', {
          ip,
          traceId,
          orderNumber: existing.orderNumber,
          revision: existing.checkoutRevision,
        });
        return buildCheckoutResponse(
          existing,
          attached.redirectUrl,
          'updated',
        );
      } catch (gatewayError) {
        existing.status = 'failed';
        existing.internalNotes = [
          ...(existing.internalNotes ?? []),
          {
            text: `Gateway payment creation failed on update: ${gatewayError instanceof Error ? gatewayError.message : 'unknown'}`,
            author: 'system',
            createdAt: new Date(),
          },
        ];
        await existing.save().catch(() => { });
        throw gatewayError;
      }
    };

    // ── Reuse lookup — openCheckoutKey is unique among open unpaid
    //    orders, so at most one doc can hold this slot. ──
    try {
      const slotHolder = await Order.findOne({ openCheckoutKey });

      if (slotHolder) {
        const isFresh =
          new Date(slotHolder.createdAt ?? 0).getTime() >=
          Date.now() - CHECKOUT_REUSE_WINDOW_MS;
        const isOpenUnpaid =
          OPEN_CHECKOUT_STATUSES.includes(slotHolder.status) &&
          (slotHolder.paidAmount ?? 0) === 0;

        if (!isFresh || !isOpenUnpaid) {
          // Stale or wrongly-held slot — release it so the new order
          // can claim the key (self-healing for missed hook clears).
          await Order.updateOne(
            { _id: slotHolder._id },
            { $unset: { openCheckoutKey: '' } },
          );
        } else {
          const reuseResponse = await decideExistingCheckout(slotHolder);
          if (reuseResponse) {
            if (tokenToSet) setAuthCookie(reuseResponse, checkoutAppId, tokenToSet);
            return reuseResponse;
          }
        }
      }
    } catch (reuseError) {
      // A gateway failure during revive/update was already persisted as
      // 'failed' on the order — surface it. Lookup bugs fall through to
      // the create path (never block checkout on reuse issues).
      if (reuseError instanceof GatewayPaymentError) {
        captureException(reuseError, {
          service: 'Checkout',
          operation: 'reuseGatewayPayment',
          severity: 'high',
        });
        return NextResponse.json(
          {
            success: false,
            error: 'Payment gateway error. Please try again.',
          },
          { status: 502 },
        );
      }
      log('warn', 'checkout.reuse_lookup_failed', {
        ip,
        traceId,
        error:
          reuseError instanceof Error ? reuseError.message : 'unknown',
      });
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

    // ── Deferred R2 uploads — only the create path reaches here with
    //    unmaterialized pictures (update-in-place uploads inside
    //    decideExistingCheckout). ──
    await materializeReservationPictures(
      reservationAnswers,
      pendingPictureUploads,
    );

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
        country: resolvedBillingCountry,
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
      reservationData: reservationAnswers,
      source: orderSource,
      latestClientIp: partialPaymentIdentity.normalizedIp,
      deviceFingerprint: partialPaymentIdentity.normalizedFingerprint,
      location: normalizeCountryName(locationCode) || undefined,
      locale,
      attribution: attribution
        ? {
          ...attribution,
          clientIp: ip || undefined,
          userAgent:
            request.headers.get('user-agent') || undefined,
        }
        : undefined,
      // Checkout reuse identity — claims the open slot for this
      // customer+basket so a concurrent submit can't create a twin.
      checkoutFingerprint,
      checkoutIdentity,
      openCheckoutKey,
      payments: [],
      paymentAttempts: [],
    };

    const maxOrderCreateRetries = 3;

    const createOrderWithRetries = async () => {
      for (let attempt = 1; attempt <= maxOrderCreateRetries; attempt += 1) {
        try {
          return await Order.create(orderPayload);
        } catch (orderCreateError) {
          const errorCode = (orderCreateError as { code?: number })?.code;
          const message =
            orderCreateError instanceof Error ? orderCreateError.message : '';

          // Concurrent submit won the openCheckoutKey slot — join the
          // winner's order instead of creating a twin. If the winner is
          // no longer open (paid/cancelled mid-flight), release the slot
          // and retry the create.
          if (errorCode === 11000 && message.includes('openCheckoutKey')) {
            const winner = await Order.findOne({ openCheckoutKey });
            if (winner) {
              let joined: NextResponse | null = null;
              try {
                joined = await decideExistingCheckout(winner);
              } catch (joinError) {
                if (joinError instanceof GatewayPaymentError) {
                  return NextResponse.json(
                    {
                      success: false,
                      error: 'Payment gateway error. Please try again.',
                    },
                    { status: 502 },
                  );
                }
                throw joinError;
              }
              if (joined) return joined;
              await Order.updateOne(
                { _id: winner._id },
                { $unset: { openCheckoutKey: '' } },
              );
            }
            if (attempt < maxOrderCreateRetries) continue;
            throw orderCreateError;
          }

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

    const created = await createOrderWithRetries();

    // A concurrent-submit join returns a full response instead of an
    // order doc — pass it through with the auth cookie if needed.
    if (created instanceof NextResponse) {
      if (tokenToSet) setAuthCookie(created, checkoutAppId, tokenToSet);
      return created;
    }

    const order = created;

    // ── Share campaign detection (silent) ──
    // If this product has an active share campaign, mark the order item
    // as a share purchase. The soldShares increment happens later in
    // the webhook when payment is confirmed. The customer never sees
    // this. Best-fit prefers the campaign closest to completion.
    try {
      await retagShareCampaign(order._id);
    } catch (shareError) {
      // If share detection fails, the order should still proceed.
      console.error('[checkout] Share campaign detection failed:', shareError);
    }

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
      // Reuse the browser's event id when provided so Meta dedupes the
      // pixel + CAPI InitiateCheckout into a single event.
      eventId: initiateCheckoutEventId || undefined,
      value: payAmount,
      currency: currencyUpper,
      numItems: quantity,
      source: orderSource,
      sourceUrl: `${orderSource === 'ghadaq'
        ? process.env.GHADAQ_URL || 'https://www.ghadaqplus.com'
        : process.env.MANASIK_URL || 'https://www.manasik.net'
        }/checkout`,
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
        fbc: attribution?.fbc,
        fbp: attribution?.fbp,
        external_id: order._id.toString(),
      },
    }).catch(() => { });

    // ── EasyKash payment — shared helper pushes the -P1 entry ──
    try {
      const attached = await attachEasykashPayment({
        order,
        orderAmount: payAmount,
        orderCurrency: currencyUpper,
        customerName: billingData.fullName,
        customerEmail: resolvedBillingEmail,
        customerPhone: resolvedBillingPhone,
        ip,
        userId: effectiveUserId,
      });

      order.status = 'processing';
      await order.save();

      const response = buildCheckoutResponse(
        order,
        attached.redirectUrl,
        'created',
      );
      if (tokenToSet) setAuthCookie(response, checkoutAppId, tokenToSet);
      return response;
    } catch (gatewayError) {
      // Never hard-delete the order — mark it failed so the audit trail
      // survives and the next retry can revive the same order number.
      const isLowAmount =
        gatewayError instanceof GatewayPaymentError &&
        gatewayError.code === 'amount_too_low';
      const isNotConfigured =
        gatewayError instanceof GatewayPaymentError &&
        gatewayError.code === 'not_configured';
      const isConversion =
        gatewayError instanceof GatewayPaymentError &&
        gatewayError.code === 'conversion_failed';

      if (isNotConfigured) {
        // Gateway absent — order is created but unpayable; return it
        // without a checkoutUrl (previous behavior kept the order too).
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
            checkoutAction: 'created',
            message:
              'Payment gateway not configured. Order created successfully.',
          },
        });
        if (tokenToSet) setAuthCookie(response, checkoutAppId, tokenToSet);
        return response;
      }

      order.status = 'failed';
      order.internalNotes = [
        ...(order.internalNotes ?? []),
        {
          text: `Gateway payment creation failed on create: ${gatewayError instanceof Error ? gatewayError.message : 'unknown'}`,
          author: 'system',
          createdAt: new Date(),
        },
      ];
      await order.save().catch(() => { });

      captureException(gatewayError, {
        service: 'Checkout',
        operation: 'createPayment_EasyKash',
        severity: isConversion ? 'critical' : 'high',
        metadata: { orderNumber: order.orderNumber },
      });

      return NextResponse.json(
        {
          success: false,
          error: isLowAmount
            ? gatewayError instanceof Error
              ? gatewayError.message
              : 'Payment amount is too low.'
            : isConversion
              ? `${gatewayError instanceof Error ? gatewayError.message : 'Conversion failed'}. Please try again or select a different currency.`
              : 'Payment gateway error. Please try again.',
        },
        { status: isLowAmount ? 400 : 502 },
      );
    }
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
