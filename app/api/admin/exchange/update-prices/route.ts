import { NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import Product from '@/lib/models/Product';
import Coupon from '@/lib/models/Coupon';
import Country from '@/lib/models/Country';
import CronLog from '@/lib/models/CronLog';
import { convertToMultipleCurrencies } from '@/lib/services/currency';
import { buildCurrencyRoundingMap, roundPrice } from '@/lib/currency-rounding';
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

    for (const product of products) {
      let modified = false;

      // Update size prices (skip manual prices)
      for (const size of product.sizes) {
        const converted = await convertToMultipleCurrencies(
          size.price,
          product.baseCurrency,
          targetCurrencies,
        );

        for (const [code, amount] of Object.entries(converted)) {
          const existingIndex = size.prices.findIndex(
            (p: { currencyCode: string }) => p.currencyCode === code,
          );

          if (existingIndex >= 0) {
            if (!size.prices[existingIndex].isManual) {
              size.prices[existingIndex].amount = roundPrice(
                amount,
                code,
                roundingMap,
              );
              modified = true;
            }
          } else {
            size.prices.push({
              currencyCode: code,
              amount: roundPrice(amount, code, roundingMap),
              isManual: false,
            });
            modified = true;
          }
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
