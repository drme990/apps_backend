import { NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import Product from '@/lib/models/Product';
import Country from '@/lib/models/Country';
import CronLog from '@/lib/models/CronLog';
import { convertToMultipleCurrencies } from '@/lib/services/currency';

export async function GET(request: Request) {
  // Verify the request is from Vercel Cron
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json(
      { success: false, error: 'Unauthorized' },
      { status: 401 },
    );
  }

  const startTime = Date.now();

  try {
    await connectDB();

    // Get all active country currency codes as target currencies
    const countries = await Country.find({ isActive: true })
      .select('currencyCode')
      .lean();
    const targetCurrencies = [
      ...new Set(countries.map((c) => c.currencyCode.toUpperCase())),
    ];

    if (targetCurrencies.length === 0) {
      return NextResponse.json({
        success: true,
        message: 'No active countries found, skipping price update',
        updated: 0,
      });
    }

    const products = await Product.find({});
    let updatedCount = 0;

    for (const product of products) {
      let modified = false;

      // Update size prices
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
              size.prices[existingIndex].amount = Math.ceil(amount);
              modified = true;
            }
          } else {
            size.prices.push({
              currencyCode: code,
              amount: Math.ceil(amount),
              isManual: false,
            });
            modified = true;
          }
        }
      }

      // Update partial payment minimums
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
                  Math.ceil(amount);
                modified = true;
              }
            } else {
              product.partialPayment.minimumPayments.push({
                currencyCode: code,
                value: Math.ceil(amount),
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

    console.log(
      `[Cron] Updated prices for ${updatedCount}/${products.length} products with ${targetCurrencies.length} currencies`,
    );

    await CronLog.create({
      jobName: 'update-prices',
      status: 'success',
      totalProducts: products.length,
      updatedCount,
      targetCurrencies,
      duration: Date.now() - startTime,
    });

    return NextResponse.json({
      success: true,
      message: `Updated ${updatedCount} products`,
      totalProducts: products.length,
      updatedCount,
      targetCurrencies,
    });
  } catch (error) {
    console.error('[Cron] Error updating product prices:', error);

    try {
      await CronLog.create({
        jobName: 'update-prices',
        status: 'failed',
        totalProducts: 0,
        updatedCount: 0,
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
