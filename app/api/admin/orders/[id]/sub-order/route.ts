import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import Order from '@/lib/models/Order';
import Product from '@/lib/models/Product';
import Booking from '@/lib/models/Booking';
import {
  refreshDefaultExecutionDateCache,
  skipBlockedDates,
} from '@/lib/execution-date';
import { logActivity } from '@/lib/services/logger';
import {
  resolveUnitPrice,
} from '@/lib/services/price-resolver';
import { syncSharedFields } from '@/lib/services/sub-order-sync';

import { parseJsonBody } from '@/lib/validation/http';
import { subOrderCreateSchema } from '@/lib/validation/schemas';
import { MANUAL_ORDER_PRODUCT_ID } from '@/lib/constants/manual-order';
import { evaluateAndTriggerAutoDesign } from '@/lib/services/auto-design-generation';

export const maxDuration = 120;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess(['orders']);
    if ('error' in auth) return auth.error;

    const { id: parentId } = await params;

    const parsed = await parseJsonBody(request, subOrderCreateSchema);
    if (!parsed.success) return parsed.response;
    const body = parsed.data;

    const { items, reservationData: reservationInput } = body;

    // ── Load parent order ──
    const parent = await Order.findById(parentId).lean();
    if (!parent) {
      return NextResponse.json(
        { success: false, error: 'Parent order not found' },
        { status: 404 },
      );
    }

    // Sub-orders cannot have sub-orders
    if (parent.isSubOrder) {
      return NextResponse.json(
        { success: false, error: 'Sub-orders cannot have their own sub-orders' },
        { status: 400 },
      );
    }

    // Free orders cannot have sub-orders
    if (parent.isFreeOrder) {
      return NextResponse.json(
        { success: false, error: 'Free orders cannot have sub-orders' },
        { status: 400 },
      );
    }

    // Only 1 sub-order per parent
    if (parent.hasSubOrder) {
      return NextResponse.json(
        { success: false, error: 'This order already has a sub-order' },
        { status: 400 },
      );
    }

    const currencyUpper = (parent.currency || 'SAR').toUpperCase();

    // ── Resolve each item (same logic as create route) ──
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

      // existing product
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
              { success: false, error: `Unable to resolve price in ${currencyUpper} for ${product.name.en || product.name.ar}: ${reason}` },
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
            { success: false, error: `Unable to resolve price in ${currencyUpper} for ${product.name.en || product.name.ar}: ${reason}` },
            { status: 400 },
          );
        }
      }

      const customPrice = typeof item.customPrice === 'number' ? item.customPrice : null;
      const unitPrice = customPrice !== null && customPrice >= 0 ? customPrice : originalPrice;

      if (unitPrice <= 0) {
        return NextResponse.json(
          { success: false, error: `Product price not configured for ${currencyUpper}: ${product.name.en || product.name.ar}` },
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
    }

    // ── Resolve reservation data (provided by user for this sub-order) ──
    // Resolve execution date (same logic as create route)
    let defaultExecutionDate = await refreshDefaultExecutionDateCache();
    const booking = await Booking.findOne({ key: 'global' }).lean();
    const blockedExecutionDates = new Set(
      (booking?.blockedExecutionDates ?? []).filter((value: string) =>
        /^\d{4}-\d{2}-\d{2}$/.test(value),
      ),
    );

    if (blockedExecutionDates.has(defaultExecutionDate)) {
      defaultExecutionDate = skipBlockedDates(defaultExecutionDate, blockedExecutionDates);
      await Booking.updateOne(
        { key: 'global' },
        { $set: { defaultExecutionDate } },
      );
    }

    const userExecutionDate = (reservationInput || []).find(
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
          { success: false, error: `Execution date must be on or after ${today}` },
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

    // Build reservation answers array (same structure as create route)
    const reservationAnswers: Array<{
      key: string;
      label: { ar: string; en: string };
      type: string;
      value: string;
    }> = [];

    let hasExecutionDateField = false;

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

    for (const entry of reservationInput || []) {
      const key = entry.key;
      if (key === 'executionDate') {
        hasExecutionDateField = true;
        reservationAnswers.push({
          key,
          label: labels[key] || { ar: key, en: key },
          type: types[key] || 'date',
          value: resolvedExecutionDate,
        });
      } else {
        reservationAnswers.push({
          key,
          label: labels[key] || { ar: key, en: key },
          type: types[key] || 'text',
          value: entry.value.trim(),
        });
      }
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

    // ── Create sub-order (no payment collected — financials follow parent) ──
    // NOTE: parent.totalAmount may store only the paid portion for partial
    // payment orders, so we don't use it for the combined total. The combined
    // total is recalculated from both orders' items by syncSharedFields.
    const subOrderPayload = {
      items: orderItemsPayload,
      isGuest: parent.isGuest,
      userId: parent.userId || undefined,
      totalAmount,
      fullAmount: totalAmount, // will be overwritten by syncSharedFields
      paidAmount: parent.paidAmount || 0,
      remainingAmount: 0, // will be recalculated by pre-save hook
      isPartialPayment: parent.isPartialPayment || false,
      paymentType: parent.paymentType || 'full',
      paymentMethod: parent.paymentMethod || 'other',
      currency: currencyUpper,
      status: parent.status || 'pending',
      billingData: parent.billingData,
      reservationData: reservationAnswers,
      source: parent.source,
      referralId: parent.referralId || undefined,
      locale: parent.locale,
      payments: [] as Array<Record<string, unknown>>,
      paymentAttempts: [],
      invoiceUrls: [],
      createdByAdminId: auth.user.userId,
      createdByAdminEmail: auth.user.email,
      createdByAdminName: auth.user.name,
      isSubOrder: true,
      parentOrderId: parent._id,
    };

    const subOrder = await Order.create(subOrderPayload);
    subOrder.orderNumber = `S${subOrder.orderNumber}`;
    await subOrder.save();

    // Link sub-order to parent (fullAmount will be set by syncSharedFields)
    const parentUpdate = await Order.findById(parent._id);
    if (parentUpdate) {
      parentUpdate.hasSubOrder = true;
      parentUpdate.subOrderId = subOrder._id;
      await parentUpdate.save();
    }

    // Sync shared fields — propagate parent's existing payments/invoices
    // to the new sub-order (which has empty arrays at creation)
    await syncSharedFields(String(parent._id));

    await logActivity({
      userId: auth.user.userId,
      userName: auth.user.name,
      userEmail: auth.user.email,
      action: 'create',
      resource: 'order',
      resourceId: subOrder._id.toString(),
      details: `Created sub-order ${subOrder.orderNumber} from parent ${parent.orderNumber} with ${items.length} item(s)`,
    });

    evaluateAndTriggerAutoDesign(
      subOrder.toObject(),
      'pending',
      'auto_admin',
    ).catch((err) => {
      console.error(`[Sub-Order] Auto design evaluation failed for ${subOrder.orderNumber}:`, err);
    });

    return NextResponse.json({
      success: true,
      data: {
        order: {
          _id: subOrder._id,
          orderNumber: subOrder.orderNumber,
          totalAmount: subOrder.totalAmount,
          fullAmount: subOrder.fullAmount,
          paidAmount: subOrder.paidAmount,
          remainingAmount: subOrder.remainingAmount,
          isPartialPayment: subOrder.isPartialPayment,
          currency: subOrder.currency,
          status: subOrder.status,
          parentOrderId: parent._id,
          isSubOrder: true,
        },
      },
    });
  } catch (error) {
    console.error('[Sub-Order Create] Error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to create sub-order' },
      { status: 500 },
    );
  }
}
