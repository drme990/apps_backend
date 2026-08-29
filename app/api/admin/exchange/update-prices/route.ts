import { NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import Product from '@/lib/models/Product';
import Coupon from '@/lib/models/Coupon';
import Country from '@/lib/models/Country';
import CronLog, { type IPriceChange } from '@/lib/models/CronLog';
import { convertToMultipleCurrencies } from '@/lib/services/currency';
import { buildCurrencyRoundingMap, roundPrice } from '@/lib/currency-rounding';
import { getBasePrice } from '@/lib/services/price-resolver';
import { syncCouponCurrencyPrices } from '@/lib/services/exchange-price-sync';

export async function POST() {
  const startTime = Date.now();

  try {
    await connectDB();
    const auth = await requireAdminPageAccess('exchange');
    if ('error' in auth) return auth.error;

    // Get all active country currency codes
    const countries = await Country.find({ isActive: true })
      .select('currencyCode roundingRule')
      .lean();
    const targetCurrencies = [
      ...new Set(countries.map((c) => c.currencyCode.toUpperCase())),
    ];
    const roundingMap = buildCurrencyRoundingMap(countries);

    if (targetCurrencies.length === 0) {
      return NextResponse.json({
        success: true,
        message: 'No active countries found, skipping price update',
        updatedCount: 0,
        totalProducts: 0,
        totalCoupons: 0,
        updatedCouponCount: 0,
      });
    }

    const [products, coupons] = await Promise.all([
      Product.find({}),
      Coupon.find({}),
    ]);
    let updatedCount = 0;
    let updatedCouponCount = 0;
    const priceChanges: IPriceChange[] = [];

    for (const product of products) {
      let modified = false;
      const productId = String(product._id);
      const productNameAr = product.name?.ar || '';
      const productNameEn = product.name?.en || '';

      // Update size prices — convert from the size's basePrice to all
      // target currencies, overwriting non-manual entries.
      // basePrice is the dedicated field for exchange calculations.
      // Fall back to prices[] lookup for old docs without basePrice.
      for (const size of product.sizes) {
        const basePrice = size.basePrice > 0
          ? size.basePrice
          : getBasePrice(size, product.baseCurrency);

        // Skip sizes with no base price — don't overwrite existing
        // prices with 0 (which would destroy them).
        if (basePrice <= 0) continue;

        const sizeNameAr = size.name?.ar || '';
        const sizeNameEn = size.name?.en || '';

        const converted = await convertToMultipleCurrencies(
          basePrice,
          product.baseCurrency,
          targetCurrencies,
        );

        for (const [code, amount] of Object.entries(converted)) {
          const newAmount = roundPrice(amount, code, roundingMap);
          const existingIndex = size.prices.findIndex(
            (p: { currencyCode: string }) => p.currencyCode === code,
          );

          let prevValue = 0;
          let isManual = false;

          if (existingIndex >= 0) {
            prevValue = size.prices[existingIndex].amount;
            isManual = !!size.prices[existingIndex].isManual;
            if (!isManual) {
              size.prices[existingIndex].amount = newAmount;
              modified = true;
            }
          } else {
            size.prices.push({
              currencyCode: code,
              amount: newAmount,
              isManual: false,
            });
            modified = true;
          }

          // Record this evaluation for the log
          const changed = prevValue !== newAmount;
          priceChanges.push({
            productId,
            productNameAr,
            productNameEn,
            sizeNameAr,
            sizeNameEn,
            currencyCode: code,
            prevValue,
            newValue: isManual ? prevValue : newAmount,
            changed: isManual ? false : changed,
            isManual,
          });
        }
      }

      // Update partial payment minimums (skip manual)
      if (product.partialPayment?.minimumPayments) {
        const baseCurrency = product.baseCurrency;
        const baseMinimum = product.partialPayment.minimumPayments.find(
          (mp: { currencyCode: string }) => mp.currencyCode === baseCurrency,
        );

        if (baseMinimum) {
          const converted = await convertToMultipleCurrencies(
            baseMinimum.value,
            baseCurrency,
            targetCurrencies,
          );

          for (const [code, amount] of Object.entries(converted)) {
            const existingIndex =
              product.partialPayment.minimumPayments.findIndex(
                (mp: { currencyCode: string }) => mp.currencyCode === code,
              );

            if (existingIndex >= 0) {
              if (
                !product.partialPayment.minimumPayments[existingIndex].isManual
              ) {
                product.partialPayment.minimumPayments[existingIndex].value =
                  roundPrice(amount, code, roundingMap);
                modified = true;
              }
            } else {
              product.partialPayment.minimumPayments.push({
                currencyCode: code,
                value: roundPrice(amount, code, roundingMap),
                isManual: false,
              });
              modified = true;
            }
          }
        }
      }

      if (modified) {
        await product.save();
        updatedCount++;
      }
    }

    for (const coupon of coupons) {
      const syncResult = await syncCouponCurrencyPrices(
        coupon,
        targetCurrencies,
        roundingMap,
      );

      if (syncResult.modified) {
        await coupon.save();
        updatedCouponCount++;
      }
    }

    const duration = Date.now() - startTime;

    await CronLog.create({
      jobName: 'update-prices',
      status: 'success',
      source: 'manual',
      totalProducts: products.length,
      updatedCount,
      totalCoupons: coupons.length,
      updatedCouponCount,
      targetCurrencies,
      duration,
      priceChanges,
    });

    return NextResponse.json({
      success: true,
      message: `Updated ${updatedCount} products and synced ${updatedCouponCount} coupons`,
      totalProducts: products.length,
      updatedCount,
      totalCoupons: coupons.length,
      updatedCouponCount,
      targetCurrencies,
      duration,
    });
  } catch (error) {
    console.error('Error updating product prices:', error);

    try {
      await CronLog.create({
        jobName: 'update-prices',
        status: 'failed',
        source: 'manual',
        totalProducts: 0,
        updatedCount: 0,
        totalCoupons: 0,
        updatedCouponCount: 0,
        targetCurrencies: [],
        errorMessage: error instanceof Error ? error.message : 'Unknown error',
        duration: Date.now() - startTime,
      });
    } catch {
      // Ignore logging failure
    }

    return NextResponse.json(
      { success: false, error: 'Failed to update product prices' },
      { status: 500 },
    );
  }
}
