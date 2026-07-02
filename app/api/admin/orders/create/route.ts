import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import Order from '@/lib/models/Order';
import Product from '@/lib/models/Product';
import User from '@/lib/models/User';
import Booking from '@/lib/models/Booking';
import {
  refreshDefaultExecutionDateCache,
  skipBlockedDates,
} from '@/lib/execution-date';
import { logActivity } from '@/lib/services/logger';
import { createPayment, getEasykashCashExpiryHours } from '@/lib/services/easykash';
import { convertCurrency } from '@/lib/services/currency';
import { parseJsonBody } from '@/lib/validation/http';
import { manualOrderCreateSchema } from '@/lib/validation/schemas';
import { getUserModelByAppId, type BaseAppUserModel, normalizeAppUserPhone } from '@/lib/auth/app-users';
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

export async function POST(request: NextRequest) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess(['orders', 'execution']);
    if ('error' in auth) return auth.error;

    const parsed = await parseJsonBody(request, manualOrderCreateSchema);
    if (!parsed.success) return parsed.response;
    const body = parsed.data;

    const {
      source,
      items,
      currency,
      referralId,
      billingData,
      reservationData,
      paymentMethod,
      invoiceUrl,
      invoiceReviewed,
      invoiceValue,
      invoiceCurrency,
      invoiceUrls,
      locale,
      userId,
      paidAmount: requestedPaidAmount,
    } = body;

    // Support both legacy single-invoice fields and new invoiceUrls array
    const initialInvoiceUrls = invoiceUrls && Array.isArray(invoiceUrls) && invoiceUrls.length > 0
      ? invoiceUrls.map((u: { url: string; reviewed?: boolean; value?: number; currency?: string }) => ({
        url: u.url,
        reviewed: u.reviewed === true,
        value: u.value ?? 0,
        currency: u.currency || 'EGP',
      }))
      : invoiceUrl
        ? [{ url: invoiceUrl, reviewed: invoiceReviewed === true, value: invoiceValue, currency: invoiceCurrency || 'EGP' }]
        : [];

    const orderSource: 'manasik' | 'ghadaq' = source;

    // ── Enforce referral ownership for non-super-admins ──
    let effectiveReferralId = referralId;
    const isSuperAdmin = auth.user.role === 'super_admin';
    if (!isSuperAdmin) {
      const adminUser = await User.findById(auth.user.userId).select('ref').lean();
      const adminRef = adminUser?.ref;
      if (effectiveReferralId && effectiveReferralId !== adminRef) {
        return NextResponse.json(
          { success: false, error: 'You can only create orders with your own referral code' },
          { status: 403 },
        );
      }
      if (!effectiveReferralId && adminRef) {
        effectiveReferralId = adminRef;
      }
    }

    // Apply source-based default if still no referral
    if (!effectiveReferralId) {
      effectiveReferralId = orderSource === 'ghadaq' ? 'GHD-D' : 'MNK-D';
    }

    const currencyUpper = currency.toUpperCase();

    // ── Resolve the effective customer name ──
    const reservationInput = Array.isArray(reservationData) ? reservationData : [];
    const firstSacrificeName = reservationInput
      .find((r): r is { key: string; value: string } => r.key === 'sacrificeFor')
      ?.value?.split('\n')
      .map((n) => n.trim())
      .filter(Boolean)[0];
    const effectiveFullName = billingData.fullName.trim()
      ? billingData.fullName.trim()
      : firstSacrificeName
        ? `User_${firstSacrificeName}`
        : '';

    // ── Resolve or create the customer user ──
    let resolvedUserId = userId;
    let createdUser: { email: string; password: string } | null = null;
    const AppUserModel = getUserModelByAppId(orderSource) as BaseAppUserModel;
    if (!resolvedUserId) {
      const trimmedEmail = billingData.email.trim().toLowerCase();
      const normalizedPhone = normalizeAppUserPhone(billingData.phone);
      let existingUser = null;
      if (trimmedEmail) {
        existingUser = await AppUserModel.findOne({ email: trimmedEmail }).select('_id').lean();
      }
      if (!existingUser && normalizedPhone) {
        existingUser = await AppUserModel.findOne({ phone: normalizedPhone }).select('_id').lean();
      }
      if (existingUser) {
        resolvedUserId = String(existingUser._id);
      } else {
        try {
          const newUser = await AppUserModel.create({
            name: effectiveFullName || trimmedEmail,
            email: trimmedEmail,
            password: trimmedEmail,
            phone: normalizedPhone,
            country: billingData.country.trim() || '',
            appId: orderSource,
            isAdminCreated: true,
          });
          resolvedUserId = String(newUser._id);
          createdUser = { email: trimmedEmail, password: trimmedEmail };
        } catch (error) {
          // If another request created the same user in the meantime, reuse it.
          const isDuplicateKey =
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            (error as { code: unknown }).code === 11000;
          if (isDuplicateKey) {
            const existingUser = await AppUserModel.findOne({
              $or: [
                ...(trimmedEmail ? [{ email: trimmedEmail }] : []),
                ...(normalizedPhone ? [{ phone: normalizedPhone }] : []),
              ],
            })
              .select('_id')
              .lean();
            if (existingUser) {
              resolvedUserId = String(existingUser._id);
            } else {
              console.error('Create manual order duplicate key but no existing user:', error);
              return NextResponse.json(
                { success: false, error: 'Failed to create customer user' },
                { status: 500 },
              );
            }
          } else {
            console.error('Create manual order user error:', error);
            return NextResponse.json(
              { success: false, error: 'Failed to create customer user' },
              { status: 500 },
            );
          }
        }
      }
    }

    // ── Resolve each item ──
    const orderItemsPayload: Array<{
      productId?: string;
      productSlug?: string;
      productName: { ar: string; en: string };
      price: number;
      originalPrice?: number;
      currency: string;
      quantity: number;
      sizeIndex?: number;
      sizeName?: { ar: string; en: string };
      isCustom?: boolean;
      customSize?: string;
    }> = [];

    let totalAmount = 0;

    for (const item of items) {
      if (item.type === 'custom') {
        if (item.price <= 0) {
          return NextResponse.json(
            { success: false, error: `Custom item price must be greater than zero: ${item.name}` },
            { status: 400 },
          );
        }

        const itemTotal = item.price * item.quantity;
        totalAmount += itemTotal;

        orderItemsPayload.push({
          productName: { ar: item.name, en: item.name },
          price: item.price,
          currency: currencyUpper,
          quantity: item.quantity,
          isCustom: true,
          customSize: item.size,
        });
        continue;
      }

      const product = await Product.findOne({
        _id: item.productId,
        isDeleted: { $ne: true },
      });
      if (!product) {
        return NextResponse.json(
          { success: false, error: `Product not found: ${item.productId}` },
          { status: 404 },
        );
      }
      if (!product.inStock) {
        return NextResponse.json(
          { success: false, error: `Product out of stock: ${product.name.en || product.name.ar}` },
          { status: 400 },
        );
      }
      if (!product.isActive) {
        return NextResponse.json(
          { success: false, error: `Product unavailable: ${product.name.en || product.name.ar}` },
          { status: 400 },
        );
      }

      const activeSizeIndex =
        item.sizeIndex >= 0 && item.sizeIndex < product.sizes.length
          ? item.sizeIndex
          : 0;
      const selectedSize = product.sizes[activeSizeIndex] as {
        manualPrice?: number | null;
        name?: { ar: string; en: string };
        price: number;
        prices?: { currencyCode: string; amount: number }[];
        isAvailable?: boolean;
      };
      if (selectedSize?.isAvailable === false) {
        return NextResponse.json(
          { success: false, error: `Selected size unavailable for: ${product.name.en || product.name.ar}` },
          { status: 400 },
        );
      }

      let originalPrice = 0;
      if (typeof selectedSize.manualPrice === 'number' && selectedSize.manualPrice > 0) {
        // Manual price is always in EGP — use it directly when order currency is EGP,
        // otherwise fall back to the regular multi-currency price for non-EGP currencies.
        if (currencyUpper === 'EGP') {
          originalPrice = selectedSize.manualPrice;
        } else {
          originalPrice = selectedSize.price ?? 0;
          const sizeCurrencyPrice = selectedSize.prices?.find(
            (p: { currencyCode: string; amount: number }) =>
              p.currencyCode === currencyUpper,
          );
          if (sizeCurrencyPrice) {
            originalPrice = sizeCurrencyPrice.amount;
          } else if (product.baseCurrency !== currencyUpper) {
            return NextResponse.json(
              {
                success: false,
                error: `Price not available in ${currencyUpper} for ${product.name.en || product.name.ar}. Available in: ${product.baseCurrency}`,
              },
              { status: 400 },
            );
          }
        }
      } else {
        originalPrice = selectedSize.price ?? 0;
        const sizeCurrencyPrice = selectedSize.prices?.find(
          (p: { currencyCode: string; amount: number }) =>
            p.currencyCode === currencyUpper,
        );
        if (sizeCurrencyPrice) {
          originalPrice = sizeCurrencyPrice.amount;
        } else if (product.baseCurrency !== currencyUpper) {
          return NextResponse.json(
            {
              success: false,
              error: `Price not available in ${currencyUpper} for ${product.name.en || product.name.ar}. Available in: ${product.baseCurrency}`,
            },
            { status: 400 },
          );
        }
      }

      const customPrice = typeof item.customPrice === 'number' ? item.customPrice : null;
      const unitPrice = customPrice !== null && customPrice >= 0 ? customPrice : originalPrice;

      if (unitPrice <= 0) {
        return NextResponse.json(
          {
            success: false,
            error: `Product price not configured for ${currencyUpper}: ${product.name.en || product.name.ar}`,
          },
          { status: 400 },
        );
      }

      const itemTotal = unitPrice * item.quantity;
      totalAmount += itemTotal;

      orderItemsPayload.push({
        productId: product._id.toString(),
        productSlug: product.slug,
        productName: { ar: product.name.ar, en: product.name.en },
        price: unitPrice,
        originalPrice,
        currency: currencyUpper,
        quantity: item.quantity,
        sizeIndex: activeSizeIndex,
        sizeName: {
          ar: selectedSize?.name?.ar || '',
          en: selectedSize?.name?.en || '',
        },
      });
    }

    // ── Resolve execution date (same logic as checkout) ──
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

      const now = new Date();
      const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

      if (trimmed < today) {
        return NextResponse.json(
          {
            success: false,
            error: `Execution date must be on or after ${today}`,
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

    // ── Build reservation answers ──
    const reservationAnswers: Array<{
      key: string;
      label: { ar: string; en: string };
      type: string;
      value: string;
    }> = [];

    let hasExecutionDateField = false;

    for (const entry of reservationInput) {
      const key = entry.key;
      const labels: Record<string, { ar: string; en: string }> = {
        intention: { ar: 'النية', en: 'Intention' },
        sacrificeFor: { ar: 'اسم الشخص المؤدى عنه', en: 'The person on whose behalf' },
        gender: { ar: 'الجنس', en: 'Gender' },
        isAlive: { ar: 'الحالة', en: 'Status' },
        shortDuaa: { ar: 'دعاء مختصر', en: 'Short Duaa' },
        photo: { ar: 'صورة', en: 'Photo' },
        executionDate: { ar: 'تاريخ التنفيذ', en: 'Execution Date' },
      };
      const types: Record<string, string> = {
        intention: 'select',
        sacrificeFor: 'text',
        gender: 'radio',
        isAlive: 'radio',
        shortDuaa: 'textarea',
        photo: 'picture',
        executionDate: 'date',
      };

      if (key === 'executionDate') {
        hasExecutionDateField = true;
        // Always use the resolved execution date as the single source of truth
        reservationAnswers.push({
          key,
          label: labels[key] || { ar: key, en: key },
          type: types[key] || 'text',
          value: resolvedExecutionDate,
        });
        continue;
      }

      if (!entry.value?.trim()) continue;

      reservationAnswers.push({
        key,
        label: labels[key] || { ar: key, en: key },
        type: types[key] || 'text',
        value: entry.value.trim(),
      });
    }

    // Guarantee executionDate exists on EVERY order
    if (!hasExecutionDateField) {
      reservationAnswers.push({
        key: 'executionDate',
        label: { ar: 'تاريخ التنفيذ', en: 'Execution Date' },
        type: 'date',
        value: resolvedExecutionDate,
      });
    }

    // ── Determine order status and payments ──
    const isEasykash = paymentMethod === 'easykash';

    // Resolve paid amount for partial payment support
    const requestedPaid = typeof requestedPaidAmount === 'number' ? requestedPaidAmount : 0;
    const isFullPayment = requestedPaid <= 0 || requestedPaid >= totalAmount;
    const isPartialManualPayment = !isFullPayment && !isEasykash;

    // For EasyKash: if paidAmount is provided and > 0 but < total, we still
    // create a pending EasyKash link for the *remaining* amount, and record
    // the already-paid portion as a manual payment entry.
    const isPartialEasykash = !isFullPayment && isEasykash;

    let orderStatus: 'pending' | 'paid' | 'partial-paid';
    if (isEasykash) {
      orderStatus = isPartialEasykash ? 'partial-paid' : 'pending';
    } else {
      orderStatus = isPartialManualPayment ? 'partial-paid' : 'paid';
    }

    const paidAmountValue = isFullPayment
      ? (isEasykash ? 0 : totalAmount)
      : requestedPaid;
    const remainingAmountValue = isFullPayment
      ? (isEasykash ? totalAmount : 0)
      : Math.max(0, totalAmount - requestedPaid);

    const isPartialPayment = !isFullPayment;
    const paymentType: 'full' | 'partial' = isPartialPayment ? 'partial' : 'full';

    const orderPayload = {
      items: orderItemsPayload,
      isGuest: !resolvedUserId,
      userId: resolvedUserId || undefined,
      // totalAmount = the first payment amount:
      // - Full payment: the full order total
      // - Partial manual: the paid portion
      // - Partial EasyKash: the paid portion (the first entered amount); the
      //   remaining balance is collected via the EasyKash link stored in payments.
      totalAmount: isPartialPayment ? requestedPaid : totalAmount,
      fullAmount: totalAmount,
      paidAmount: paidAmountValue,
      remainingAmount: remainingAmountValue,
      isPartialPayment,
      paymentType,
      paymentMethod,
      currency: currencyUpper,
      status: orderStatus,
      billingData: {
        fullName: effectiveFullName,
        email: billingData.email.trim().toLowerCase(),
        phone: billingData.phone.trim(),
        country: billingData.country.trim() || 'N/A',
      },
      termsAgreedAt: new Date(),
      reservationData: reservationAnswers,
      source: orderSource,
      referralId: effectiveReferralId || undefined,
      locale,
      payments: [] as Array<{
        paymentId: string;
        easykashOrderId: string;
        amount: number;
        currency: string;
        status: 'pending' | 'paid';
        orderAmount?: number;
        gatewayAmount?: number;
        gatewayCurrency?: string;
        redirectUrl?: string;
        expiresAt?: Date;
        createdAt: Date;
        paidAt?: Date;
      }>,
      paymentAttempts: [],
      invoiceUrls: initialInvoiceUrls,
    };

    // ── Create order ──
    const order = await Order.create(orderPayload);

    // ── Prefix order number with W ──
    order.orderNumber = `W${order.orderNumber}`;
    await order.save();

    let checkoutUrl: string | null = null;

    // ── EasyKash payment ──
    if (isEasykash && process.env.EASYKASH_API_KEY) {
      const sourceBaseUrls: Record<string, string> = {
        manasik: process.env.MANASIK_URL || 'https://www.manasik.net',
        ghadaq: process.env.GHADAQ_URL || 'https://www.ghadaqplus.com',
      };
      const baseUrl =
        sourceBaseUrls[orderSource] || sourceBaseUrls.manasik;

      // For partial EasyKash, the gateway amount is for the *remaining* balance
      const easykashTargetAmount = isPartialEasykash ? remainingAmountValue : totalAmount;

      const EASYKASH_CURRENCIES = ['EGP', 'USD', 'SAR', 'EUR'];
      let easykashAmount = easykashTargetAmount;
      let paymentCurrency = currencyUpper;

      if (!EASYKASH_CURRENCIES.includes(currencyUpper)) {
        try {
          const convertedAmount = await convertCurrency(
            easykashTargetAmount,
            currencyUpper,
            'EGP',
          );
          if (Number.isFinite(convertedAmount) && convertedAmount > 0) {
            easykashAmount = Math.ceil(convertedAmount);
            paymentCurrency = 'EGP';
          }
        } catch {
          // Fallback: try to find EGP price on the first existing product
          const firstExistingItem = items.find((it) => it.type === 'existing');
          if (!firstExistingItem || firstExistingItem.type !== 'existing') {
            await Order.findByIdAndDelete(order._id);
            return NextResponse.json(
              {
                success: false,
                error: `Unable to convert ${currencyUpper} amount to EGP for custom items.`,
              },
              { status: 500 },
            );
          }
          const firstProduct = await Product.findById(firstExistingItem.productId).lean();
          const firstSize = firstProduct?.sizes?.[firstExistingItem.sizeIndex ?? 0];
          const egpPriceEntry = firstSize?.prices?.find(
            (p: { currencyCode: string; amount: number }) =>
              p.currencyCode === 'EGP',
          );
          if (
            typeof egpPriceEntry?.amount === 'number' &&
            egpPriceEntry.amount > 0
          ) {
            // For partial: use the EGP price * quantity, then subtract the paid portion proportionally
            const egpFull = egpPriceEntry.amount * firstExistingItem.quantity;
            easykashAmount = isPartialEasykash
              ? Math.ceil(egpFull - (requestedPaid * egpFull / totalAmount))
              : Math.ceil(egpFull);
            paymentCurrency = 'EGP';
          } else {
            await Order.findByIdAndDelete(order._id);
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

      const cashExpiryHours = getEasykashCashExpiryHours();
      const paymentId = generatePaymentId();
      let easykashResponse: Awaited<ReturnType<typeof createPayment>> | null = null;
      let easykashOrderId: string | null = null;
      const maxReferenceRetries = 5;

      const getPaymentAttemptNumber = (o: { payments?: unknown[] }): number =>
        (o.payments?.length ?? 0) + 1;

      try {
        const initialPaymentAttemptNum = getPaymentAttemptNumber(order);
        const existingReferences = new Set(
          (order.payments ?? []).map((payment: { easykashOrderId?: string }) => payment.easykashOrderId),
        );
        let paymentAttemptNum = initialPaymentAttemptNum;

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
              name: effectiveFullName,
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

        checkoutUrl = easykashResponse.redirectUrl;

        // Build payments array: if partial, record the already-paid portion as a manual payment
        const payments: Array<{
          paymentId: string;
          easykashOrderId: string;
          amount: number;
          currency: string;
          status: 'pending' | 'paid';
          orderAmount?: number;
          gatewayAmount?: number;
          gatewayCurrency?: string;
          redirectUrl?: string;
          expiresAt?: Date;
          createdAt: Date;
          paidAt?: Date;
        }> = [];

        if (isPartialEasykash) {
          // Record the already-paid portion as a manual paid payment
          payments.push({
            paymentId: `manual_${Date.now()}`,
            easykashOrderId: `manual-${Date.now()}`,
            orderAmount: requestedPaid,
            gatewayAmount: requestedPaid,
            gatewayCurrency: currencyUpper,
            amount: requestedPaid,
            currency: currencyUpper,
            status: 'paid',
            createdAt: new Date(),
            paidAt: new Date(),
          });
        }

        // Add the EasyKash pending payment for the remaining amount
        payments.push({
          paymentId,
          easykashOrderId,
          orderAmount: easykashTargetAmount,
          gatewayAmount: easykashAmount,
          gatewayCurrency: paymentCurrency,
          amount: easykashTargetAmount,
          currency: currencyUpper,
          status: 'pending',
          redirectUrl: easykashResponse.redirectUrl,
          expiresAt: new Date(Date.now() + cashExpiryHours * 60 * 60 * 1000),
          createdAt: new Date(),
        });

        order.payments = payments;
        await order.save();
      } catch (easykashError) {
        await Order.findByIdAndDelete(order._id);
        console.error('EasyKash payment creation error:', easykashError);
        return NextResponse.json(
          { success: false, error: 'Payment gateway error. Please try again.' },
          { status: 502 },
        );
      }
    } else if (!isEasykash) {
      // For manual payment methods, add a manual payment record
      const paymentRecordAmount = isPartialManualPayment ? requestedPaid : totalAmount;
      order.payments = [
        {
          paymentId: `manual_${Date.now()}`,
          easykashOrderId: `manual-${Date.now()}`,
          orderAmount: paymentRecordAmount,
          gatewayAmount: paymentRecordAmount,
          gatewayCurrency: currencyUpper,
          amount: paymentRecordAmount,
          currency: currencyUpper,
          status: 'paid',
          createdAt: new Date(),
          paidAt: new Date(),
        },
      ];
      await order.save();
    }

    await logActivity({
      userId: auth.user.userId,
      userName: auth.user.name,
      userEmail: auth.user.email,
      action: 'create',
      resource: 'order',
      resourceId: order._id.toString(),
      details: `Manually created order ${order.orderNumber} via admin panel (${paymentMethod}) with ${items.length} item(s)${isPartialPayment ? ` — partial payment: ${requestedPaid} ${currencyUpper} of ${totalAmount} ${currencyUpper}` : ''}`,
    });

    return NextResponse.json({
      success: true,
      data: {
        order: {
          _id: order._id,
          orderNumber: order.orderNumber,
          totalAmount: order.totalAmount,
          fullAmount: order.fullAmount,
          paidAmount: order.paidAmount,
          remainingAmount: order.remainingAmount,
          isPartialPayment: order.isPartialPayment,
          currency: order.currency,
          status: order.status,
        },
        checkoutUrl,
        createdUser,
      },
    });
  } catch (error) {
    console.error('Error creating manual order:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to create order' },
      { status: 500 },
    );
  }
}
