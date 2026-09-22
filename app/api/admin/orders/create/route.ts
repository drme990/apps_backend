import { NextRequest, NextResponse } from 'next/server';
import mongoose from 'mongoose';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import Order, { type PaymentMethod } from '@/lib/models/Order';
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
import {
  resolveUnitPrice,
  PAYMENT_GATEWAY_CURRENCIES,
} from '@/lib/services/price-resolver';
import {
  findActiveShareCampaign,
  getSharesForSize,
  applyShareIncrementsForOrder,
} from '@/lib/services/share-campaign';

import { parseJsonBody } from '@/lib/validation/http';
import { manualOrderCreateSchema } from '@/lib/validation/schemas';
import { normalizeCountryName } from '@/lib/country-visibility';
import {
  matchReservationOption,
  normalizeReservationFields,
  type ReservationFieldDefinition,
} from '@/lib/reservation-fields';
import { getUserModelByAppId, type BaseAppUserModel, normalizeAppUserPhone } from '@/lib/auth/app-users';
import { MANUAL_ORDER_PRODUCT_ID } from '@/lib/constants/manual-order';
import { evaluateAndTriggerAutoDesign } from '@/lib/services/auto-design-generation';
import { randomBytes } from 'crypto';

// Manual order creation involves multiple DB operations, user creation,
// and potentially an EasyKash API call. Give it plenty of time.
export const maxDuration = 120;

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
    const auth = await requireAdminPageAccess(['orders']);
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
      paymentMethod: rawPaymentMethod,
      invoiceUrl,
      invoiceStatus,
      invoiceValue,
      invoiceCurrency,
      invoiceUrls,
      locale,
      userId,
      paidAmount: requestedPaidAmount,
      isFreeOrder,
      freeOrderReason,
    } = body;

    const paymentMethod = (rawPaymentMethod || 'other') as PaymentMethod;

    // Free orders require an additional permission
    if (isFreeOrder) {
      const freeOrderAuth = await requireAdminPageAccess(['freeOrders']);
      if ('error' in freeOrderAuth) {
        return NextResponse.json(
          { success: false, error: 'You do not have permission to create free orders' },
          { status: 403 },
        );
      }
    }

    const VALID_INVOICE_STATUSES = ['confirmed', 'waiting', 'pending', 'rejected', 'deleted'] as const;
    const resolveInvoiceStatus = (status?: string): 'confirmed' | 'waiting' | 'pending' | 'rejected' | 'deleted' =>
      status && VALID_INVOICE_STATUSES.includes(status as (typeof VALID_INVOICE_STATUSES)[number])
        ? (status as (typeof VALID_INVOICE_STATUSES)[number])
        : 'waiting';

    // Support both legacy single-invoice fields and new invoiceUrls array.
    // Invoices uploaded during order creation are marked `whileCreating: true`
    // — they are just attached documents. Their amount is NOT recorded as a
    // separate payment (the paid amount comes from the manually-entered
    // `paidAmount` field) and they don't appear in the payment timeline.
    const initialInvoiceUrls = invoiceUrls && Array.isArray(invoiceUrls) && invoiceUrls.length > 0
      ? invoiceUrls.map((u: { url: string; invoiceStatus?: string; value?: number; currency?: string }) => ({
        url: u.url,
        invoiceStatus: resolveInvoiceStatus(u.invoiceStatus),
        value: u.value ?? 0,
        currency: u.currency || 'EGP',
        whileCreating: true,
      }))
      : invoiceUrl
        ? [{
          url: invoiceUrl,
          invoiceStatus: resolveInvoiceStatus(invoiceStatus),
          value: invoiceValue,
          currency: invoiceCurrency || 'EGP',
          whileCreating: true,
        }]
        : [];

    const orderSource: 'manasik' | 'ghadaq' = source;

    // ── Enforce referral ownership for non-super-admins ──
    let effectiveReferralId = referralId;
    const isSuperAdmin = auth.user.role === 'super_admin';
    if (!isSuperAdmin) {
      const adminUser = await User.findById(auth.user.userId).select('ref').lean();
      const adminRefs = Array.isArray(adminUser?.ref)
        ? adminUser.ref
        : adminUser?.ref
          ? [adminUser.ref]
          : [];
      if (effectiveReferralId && !adminRefs.includes(effectiveReferralId)) {
        return NextResponse.json(
          { success: false, error: 'You can only create orders with your own referral codes' },
          { status: 403 },
        );
      }
      if (!effectiveReferralId && adminRefs.length > 0) {
        effectiveReferralId = adminRefs[0];
      }
    }

    // Apply source-based default if still no referral
    if (!effectiveReferralId) {
      effectiveReferralId = orderSource === 'ghadaq' ? 'GHD-D' : 'MNK-D';
    }

    // Validate that the referral code belongs to the selected app
    if (effectiveReferralId) {
      const { validateReferralCode } = await import('@/lib/services/referral-validation');
      const refValidation = await validateReferralCode(effectiveReferralId, orderSource);
      if (!refValidation.valid) {
        return NextResponse.json(
          { success: false, error: refValidation.message || 'Invalid referral code for this app' },
          { status: 400 },
        );
      }
    }

    const currencyUpper = currency.toUpperCase();

    // ── Resolve the effective customer name ──
    const reservationInput = Array.isArray(reservationData) ? reservationData : [];
    const effectiveFullName = billingData.fullName.trim();
    // Canonical long country name — 'EG'/'egypt' → 'Egypt'
    const billingCountry = normalizeCountryName(billingData.country);

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
        // Update termsAgreedAt on the existing user if not already set
        await AppUserModel.updateOne(
          { _id: existingUser._id, termsAgreedAt: { $exists: false } },
          { $set: { termsAgreedAt: new Date() } },
        );
      } else {
        try {
          const newUser = await AppUserModel.create({
            name: effectiveFullName || trimmedEmail,
            email: trimmedEmail,
            password: trimmedEmail,
            phone: normalizedPhone,
            country: billingCountry,
            appId: orderSource,
            isAdminCreated: true,
            termsAgreedAt: new Date(),
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
      sizeDesignName?: string;
      isCustom?: boolean;
      customSize?: string;
      isAddOn?: boolean;
      parentItemIndex?: number;
      isShare?: boolean;
      shareCampaignId?: mongoose.Types.ObjectId | string;
      shareQuantity?: number;
    }> = [];

    let totalAmount = 0;

    // Collect the union of REQUIRED reservation field keys across all selected
    // existing products. Custom products contribute nothing. executionDate is
    // excluded — the backend always assigns it (defaults to next available day).
    const requiredReservationFieldKeys = new Set<string>();

    // Merged reservation field definitions across the selected products —
    // the same union the manual-order modal renders. The first product
    // contributing a key wins for label/type; `required` is the OR;
    // select/radio options are the union across products; the tightest
    // maxLength wins.
    const mergedReservationFieldDefs = new Map<
      string,
      ReservationFieldDefinition
    >();

    for (const item of items) {
      if (item.type === 'custom') {
        if (item.price < 0 || (!isFreeOrder && item.price <= 0)) {
          return NextResponse.json(
            { success: false, error: `Custom item price must be greater than zero: ${item.name}` },
            { status: 400 },
          );
        }

        const itemTotal = item.price * item.quantity;
        totalAmount += itemTotal;

        orderItemsPayload.push({
          productId: MANUAL_ORDER_PRODUCT_ID,
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

      // Collect required reservation field keys from this product and
      // merge its field definitions for validation below.
      const productFields = normalizeReservationFields(product.reservationFields);
      for (const field of productFields) {
        if (field.required && field.key !== 'executionDate') {
          requiredReservationFieldKeys.add(field.key);
        }

        const existing = mergedReservationFieldDefs.get(field.key);
        if (!existing) {
          mergedReservationFieldDefs.set(field.key, {
            ...field,
            options: [...(field.options ?? [])],
          });
          continue;
        }
        if (field.required) existing.required = true;
        if (field.options?.length) {
          const seen = new Set(existing.options?.map((o) => o.ar) ?? []);
          for (const opt of field.options) {
            if (!seen.has(opt.ar)) {
              existing.options = [...(existing.options ?? []), opt];
              seen.add(opt.ar);
            }
          }
        }
        if (
          typeof field.maxLength === 'number' &&
          field.maxLength > 0 &&
          (!existing.maxLength || field.maxLength < existing.maxLength)
        ) {
          existing.maxLength = field.maxLength;
        }
      }

      const activeSizeIndex =
        item.sizeIndex >= 0 && item.sizeIndex < product.sizes.length
          ? item.sizeIndex
          : 0;
      const selectedSize = product.sizes[activeSizeIndex] as {
        manualPrice?: number | null;
        name?: { ar: string; en: string };
        designName?: string;
        price?: number;
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
          try {
            originalPrice = await resolveUnitPrice(
              selectedSize,
              product.baseCurrency || 'SAR',
              currencyUpper,
            );
          } catch (err) {
            const reason = err instanceof Error ? err.message : 'Unknown error';
            return NextResponse.json(
              {
                success: false,
                error: `Unable to resolve price in ${currencyUpper} for ${product.name.en || product.name.ar}: ${reason}`,
              },
              { status: 400 },
            );
          }
        }
      } else {
        try {
          originalPrice = await resolveUnitPrice(
            selectedSize,
            product.baseCurrency || 'SAR',
            currencyUpper,
          );
        } catch (err) {
          const reason = err instanceof Error ? err.message : 'Unknown error';
          return NextResponse.json(
            {
              success: false,
              error: `Unable to resolve price in ${currencyUpper} for ${product.name.en || product.name.ar}: ${reason}`,
            },
            { status: 400 },
          );
        }
      }

      const customPrice = typeof item.customPrice === 'number' ? item.customPrice : null;
      const unitPrice = customPrice !== null && customPrice >= 0 ? customPrice : originalPrice;

      if (unitPrice < 0 || (!isFreeOrder && unitPrice <= 0)) {
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
        productId: product._id,
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
        sizeDesignName: selectedSize?.designName || '',
      });

      // ── Resolve selected add-ons for this product ──
      if (
        item.selectedAddOns &&
        item.selectedAddOns.length > 0 &&
        product.addOns?.length
      ) {
        const parentItemIndex = orderItemsPayload.length - 1;
        const effectiveSelected =
          product.addOnSelectionMode === 'single'
            ? item.selectedAddOns.slice(0, 1)
            : item.selectedAddOns;

        for (const sel of effectiveSelected) {
          const addOn = product.addOns.find(
            (a: { _id?: { toString(): string } }) =>
              a._id?.toString() === sel.addOnId,
          );
          if (!addOn) continue;
          if ((addOn as { isAvailable?: boolean }).isAvailable === false)
            continue;

          let addOnPrice: number;
          try {
            addOnPrice = await resolveUnitPrice(
              { prices: (addOn as { prices?: { currencyCode: string; amount: number }[] }).prices },
              product.baseCurrency || 'SAR',
              currencyUpper,
            );
          } catch {
            continue;
          }

          if (addOnPrice <= 0) continue;

          const addOnQty = sel.quantity || 1;
          totalAmount += addOnPrice * addOnQty;

          orderItemsPayload.push({
            productId: product._id,
            productSlug: product.slug,
            productName: {
              ar: (addOn as { name: { ar: string; en: string } }).name.ar,
              en: (addOn as { name: { ar: string; en: string } }).name.en,
            },
            price: addOnPrice,
            currency: currencyUpper,
            quantity: addOnQty,
            isAddOn: true,
            parentItemIndex,
          });
        }
      }
    }

    // ── Share campaign detection (silent) ──
    // Same logic as checkout: if an item's product has an active
    // share campaign covering its size, flag the item. The actual
    // soldShares increment happens below when the order is created
    // already paid — or later in the webhook for pending EasyKash
    // orders once payment is confirmed.
    for (const payloadItem of orderItemsPayload) {
      if (payloadItem.isAddOn || payloadItem.isCustom) continue;
      if (payloadItem.sizeIndex === undefined || !payloadItem.productId)
        continue;

      try {
        const anyCampaign = await findActiveShareCampaign(
          payloadItem.productId,
        );
        if (!anyCampaign) continue;

        const sharesPerPurchase = getSharesForSize(
          anyCampaign,
          payloadItem.sizeIndex,
        );
        if (sharesPerPurchase <= 0) continue;

        const totalShares = sharesPerPurchase * payloadItem.quantity;
        const bestFit = await findActiveShareCampaign(
          payloadItem.productId,
          totalShares,
        );
        const campaignToUse = bestFit || anyCampaign;

        payloadItem.isShare = true;
        payloadItem.shareCampaignId = campaignToUse._id;
        payloadItem.shareQuantity = totalShares;
      } catch (shareError) {
        // Share detection must never block order creation.
        console.error(
          '[Create Manual Order] Share campaign detection failed:',
          shareError,
        );
      }
    }

    // ── Validate required reservation fields per selected products ──
    if (requiredReservationFieldKeys.size > 0) {
      const providedKeys = new Set(
        reservationInput
          .filter(
            (r): r is { key: string; value: string } =>
              typeof r === 'object' && r !== null && typeof r.key === 'string' && typeof r.value === 'string' && r.value.trim() !== '',
          )
          .map((r) => r.key),
      );
      const missing = [...requiredReservationFieldKeys].filter((k) => !providedKeys.has(k));
      if (missing.length > 0) {
        return NextResponse.json(
          {
            success: false,
            error: `Missing required reservation field(s): ${missing.join(', ')}`,
          },
          { status: 400 },
        );
      }
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

    // ── Build reservation answers from the merged product field config ──
    // Same semantics as checkout: only fields the selected products
    // accept are stored, select/radio values must match a configured
    // option (normalized to the canonical Arabic value), text/textarea
    // respect maxLength, and pictures are stored as a JSON URL array.
    const reservationAnswers: Array<{
      key: string;
      label: { ar: string; en: string };
      type: string;
      value: string;
    }> = [];

    const reservationInputValueFor = (key: string): string => {
      const entry = reservationInput.find(
        (r): r is { key: string; value: string } =>
          typeof r === 'object' &&
          r !== null &&
          r.key === key &&
          typeof r.value === 'string',
      );
      return entry?.value?.trim() ?? '';
    };

    let hasExecutionDateField = false;

    for (const field of mergedReservationFieldDefs.values()) {
      let finalValue = reservationInputValueFor(field.key);

      if (field.key === 'executionDate') {
        hasExecutionDateField = true;
        // Always use the resolved execution date as the single source of truth
        reservationAnswers.push({
          key: field.key,
          label: field.label,
          type: field.type,
          value: resolvedExecutionDate,
        });
        continue;
      }

      if (field.required && !finalValue) {
        return NextResponse.json(
          {
            success: false,
            error: `Missing required reservation field(s): ${field.key}`,
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
        field.options &&
        field.options.length > 0
      ) {
        const matchedOption = matchReservationOption(field, finalValue);
        if (!matchedOption) {
          return NextResponse.json(
            { success: false, error: 'Invalid reservation option' },
            { status: 400 },
          );
        }
        finalValue = matchedOption.ar;
      }

      if (field.type === 'picture') {
        // Normalize to the checkout storage format: a JSON array of
        // http(s) image URLs (legacy single-URL values are wrapped).
        let imageValues: string[] = [];
        try {
          const parsed = JSON.parse(finalValue);
          if (Array.isArray(parsed)) {
            imageValues = parsed.filter(
              (v): v is string => typeof v === 'string' && v.length > 0,
            );
          }
        } catch {
          // Not JSON — treat as a single URL (legacy)
        }
        if (imageValues.length === 0 && finalValue.length > 0) {
          imageValues = [finalValue];
        }

        imageValues = imageValues.slice(0, 4);
        if (imageValues.some((v) => !/^https?:\/\//i.test(v))) {
          return NextResponse.json(
            { success: false, error: 'Invalid reservation picture format' },
            { status: 400 },
          );
        }
        finalValue = JSON.stringify(imageValues);
      }

      reservationAnswers.push({
        key: field.key,
        label: field.label,
        type: field.type,
        value: finalValue,
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

    // Free order: no payment method, no invoice, no EasyKash.
    // The order is marked as 'paid' with zero amounts.
    if (isFreeOrder) {
      console.log('[Create Manual Order] Creating FREE order for', effectiveFullName, 'reason:', freeOrderReason.trim());
      const order = await Order.create({
        items: orderItemsPayload,
        isGuest: !resolvedUserId,
        userId: resolvedUserId || undefined,
        totalAmount: 0,
        fullAmount: 0,
        paidAmount: 0,
        remainingAmount: 0,
        isPartialPayment: false,
        paymentType: 'full',
        paymentMethod: 'other',
        currency: currencyUpper,
        status: 'paid',
        billingData: {
          fullName: effectiveFullName,
          email: billingData.email.trim().toLowerCase(),
          phone: billingData.phone.trim(),
          country: billingCountry,
        },
        reservationData: reservationAnswers,
        source: orderSource,
        referralId: effectiveReferralId || undefined,
        locale,
        payments: [],
        paymentAttempts: [],
        invoiceUrls: [],
        isFreeOrder: true,
        freeOrderReason: freeOrderReason.trim(),
        createdByAdminId: auth.user.userId,
        createdByAdminEmail: auth.user.email,
        createdByAdminName: auth.user.name,
      });
      order.orderNumber = `W${order.orderNumber}`;
      await order.save();
      console.log('[Create Manual Order] Free order created:', order.orderNumber);

      await logActivity({
        userId: auth.user.userId,
        userName: auth.user.name,
        userEmail: auth.user.email,
        action: 'create',
        resource: 'order',
        resourceId: order._id.toString(),
        details: `Manually created FREE order ${order.orderNumber} via admin panel — reason: ${freeOrderReason.trim()}`,
      });

      // Auto-generate design for free orders (they're 'paid')
      evaluateAndTriggerAutoDesign(
        order.toObject(),
        'pending',
        'auto_admin',
      ).catch((err) => {
        console.error(`[Create Manual Order] Auto design evaluation failed for ${order.orderNumber}:`, err);
      });

      return NextResponse.json({
        success: true,
        data: {
          order: {
            _id: order._id,
            orderNumber: order.orderNumber,
            totalAmount: 0,
            fullAmount: 0,
            paidAmount: 0,
            remainingAmount: 0,
            isPartialPayment: false,
            currency: order.currency,
            status: order.status,
          },
          checkoutUrl: null,
          createdUser,
        },
      });
    }

    // ── Normal (non-free) order flow ──
    const isEasykash = paymentMethod === 'easykash';

    // For order creation, the paid amount is the manually-entered
    // `paidAmount` field — NOT derived from invoice values. The invoice
    // is just an attached document. The invoice amount is only used as
    // a payment when uploading invoices to an EXISTING order (PATCH route).
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
        country: billingCountry,
      },
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
        paymentMethod?: PaymentMethod;
        redirectUrl?: string;
        expiresAt?: Date;
        createdAt: Date;
        paidAt?: Date;
      }>,
      paymentAttempts: [],
      invoiceUrls: initialInvoiceUrls,
      // Track the admin who created this manual order
      createdByAdminId: auth.user.userId,
      createdByAdminEmail: auth.user.email,
      createdByAdminName: auth.user.name,
    };

    // ── Create order ──
    console.log('[Create Manual Order] Creating order for', effectiveFullName, 'with', orderItemsPayload.length, 'items');
    const order = await Order.create(orderPayload);

    // ── Prefix order number with W ──
    order.orderNumber = `W${order.orderNumber}`;
    await order.save();
    console.log('[Create Manual Order] Order created:', order.orderNumber);

    // ── Share campaign increment ──
    // Manual orders created already paid (or partially paid) count
    // their shares immediately — the webhook never sees them.
    // Pending EasyKash orders skip this; the webhook applies the
    // increment when payment is confirmed. Idempotent via
    // sharesApplied so a later webhook can't double-count.
    if (orderStatus === 'paid' || orderStatus === 'partial-paid') {
      await applyShareIncrementsForOrder(order);
    }

    let checkoutUrl: string | null = null;

    // ── EasyKash payment ──
    if (isEasykash && process.env.EASYKASH_API_KEY) {
      console.log('[Create Manual Order] Creating EasyKash payment for', order.orderNumber);
      const sourceBaseUrls: Record<string, string> = {
        manasik: process.env.MANASIK_URL || 'https://www.manasik.net',
        ghadaq: process.env.GHADAQ_URL || 'https://www.ghadaqplus.com',
      };
      const baseUrl =
        sourceBaseUrls[orderSource] || sourceBaseUrls.manasik;

      // For partial EasyKash, the gateway amount is for the *remaining* balance
      const easykashTargetAmount = isPartialEasykash ? remainingAmountValue : totalAmount;

      let easykashAmount = easykashTargetAmount;
      let paymentCurrency = currencyUpper;

      if (!PAYMENT_GATEWAY_CURRENCIES.includes(currencyUpper as (typeof PAYMENT_GATEWAY_CURRENCIES)[number])) {
        try {
          const convertedAmount = await convertCurrency(
            easykashTargetAmount,
            currencyUpper,
            'EGP',
          );
          if (Number.isFinite(convertedAmount) && convertedAmount > 0) {
            easykashAmount = Math.ceil(convertedAmount);
            paymentCurrency = 'EGP';
          } else {
            throw new Error('Converted amount is invalid');
          }
        } catch (conversionError) {
          // Conversion failed — fail rather than charging a re-derived amount.
          await Order.findByIdAndDelete(order._id);
          const reason =
            conversionError instanceof Error
              ? conversionError.message
              : 'Unknown conversion error';
          return NextResponse.json(
            {
              success: false,
              error: `Unable to convert ${currencyUpper} amount to EGP. Please try again or select a different currency. (${reason})`,
            },
            { status: 500 },
          );
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
          paymentMethod?: PaymentMethod;
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
            paymentMethod,
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
          paymentMethod,
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
      // For manual payment methods, add a manual payment record.
      // The paid amount comes from the manually-entered `paidAmount`
      // field, NOT from the invoice values. The invoice is just an
      // attached document. Invoice amounts are only used as payments
      // when uploading invoices to an EXISTING order (PATCH route).
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
          paymentMethod,
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

    console.log('[Create Manual Order] Success:', order.orderNumber);

    // ── Auto-generate design for paid manual orders ──
    // Manual orders with 'paid' or 'partial-paid' status should have
    // their designs generated automatically, just like regular orders
    // that transition to paid via the payment webhook.
    // Always logs the decision — even when skipped.
    evaluateAndTriggerAutoDesign(
      order.toObject(),
      'pending',
      'auto_admin',
    ).catch((err) => {
      console.error(`[Create Manual Order] Auto design evaluation failed for ${order.orderNumber}:`, err);
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
    console.error('[Create Manual Order] Error:', error);

    // Extract a clean, user-friendly message from the error.
    // Mongoose duplicate key (E11000) — e.g. unique email/phone collision
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code: unknown }).code === 11000
    ) {
      const keyError = error as { keyValue?: Record<string, unknown> };
      const dupField = keyError.keyValue
        ? Object.keys(keyError.keyValue).join(', ')
        : 'field';
      return NextResponse.json(
        { success: false, error: `A customer with this ${dupField} already exists` },
        { status: 409 },
      );
    }

    // Mongoose validation error
    if (
      typeof error === 'object' &&
      error !== null &&
      'name' in error &&
      (error as { name: string }).name === 'ValidationError'
    ) {
      const msg = error instanceof Error ? error.message : 'Validation failed';
      return NextResponse.json(
        { success: false, error: msg },
        { status: 400 },
      );
    }

    // Mongoose CastError (invalid ObjectId, etc.)
    if (
      typeof error === 'object' &&
      error !== null &&
      'name' in error &&
      (error as { name: string }).name === 'CastError'
    ) {
      const castErr = error as { path?: string; value?: unknown };
      const field = castErr.path || 'field';
      return NextResponse.json(
        { success: false, error: `Invalid value for field "${field}"` },
        { status: 400 },
      );
    }

    // Already-handled NextResponse (e.g. from an inner return that threw)
    if (
      typeof error === 'object' &&
      error !== null &&
      'status' in error &&
      typeof (error as { status: unknown }).status === 'number' &&
      'json' in error
    ) {
      return error as NextResponse;
    }

    // Network/gateway errors (EasyKash, R2, etc.)
    if (error instanceof Error) {
      const msg = error.message.toLowerCase();
      if (msg.includes('timeout') || msg.includes('etimedout')) {
        return NextResponse.json(
          { success: false, error: 'The request timed out. Please try again.' },
          { status: 504 },
        );
      }
      if (msg.includes('connect') || msg.includes('econnrefused') || msg.includes('enotfound')) {
        return NextResponse.json(
          { success: false, error: 'Unable to connect to a required service. Please try again.' },
          { status: 502 },
        );
      }
      // MongoDB connection errors
      if (msg.includes('mongoserverselectionerror') || msg.includes('pool destroyed')) {
        return NextResponse.json(
          { success: false, error: 'Database connection error. Please try again.' },
          { status: 503 },
        );
      }
    }

    // For any other error, return the actual message instead of hiding it
    const message = error instanceof Error ? error.message : 'Failed to create order';
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 },
    );
  }
}
