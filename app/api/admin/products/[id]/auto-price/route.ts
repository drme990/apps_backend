import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAuth } from '@/lib/auth';
import Product from '@/lib/models/Product';
import { logActivity } from '@/lib/services/logger';
import { convertToMultipleCurrencies } from '@/lib/services/currency';
import { roundPrice } from '@/lib/currency-rounding';
import { parseJsonBody } from '@/lib/validation/http';
import { autoPriceSchema } from '@/lib/validation/schemas';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await connectDB();
    const auth = await requireAuth();
    if ('error' in auth) return auth.error;

    const { id } = await params;
    const parsed = await parseJsonBody(request, autoPriceSchema);
    if (!parsed.success) return parsed.response;
    const { targetCurrencies } = parsed.data;

    const product = await Product.findById(id);
    if (!product) {
      return NextResponse.json(
        { success: false, error: 'Product not found' },
        { status: 404 },
      );
    }

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
            size.prices[existingIndex].amount = roundPrice(amount, code);
          }
        } else {
          size.prices.push({
            currencyCode: code,
            amount: roundPrice(amount, code),
            isManual: false,
          });
        }
      }
    }

    // Also update partial payment minimums
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
                roundPrice(amount, code);
            }
          } else {
            product.partialPayment.minimumPayments.push({
              currencyCode: code,
              value: roundPrice(amount, code),
              isManual: false,
            });
          }
        }
      }
    }

    await product.save();

    await logActivity({
      userId: auth.user.userId,
      userName: auth.user.name,
      userEmail: auth.user.email,
      action: 'update',
      resource: 'product',
      resourceId: product._id.toString(),
      details: `Auto-priced product "${product.name.en || product.name.ar}" for ${targetCurrencies.join(', ')}`,
    });

    return NextResponse.json({ success: true, data: product });
  } catch (error) {
    console.error('Error auto-pricing product:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to auto-price product' },
      { status: 500 },
    );
  }
}
