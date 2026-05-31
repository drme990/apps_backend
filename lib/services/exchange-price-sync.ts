import type { RoundingRule } from '@/lib/currency-rounding';
import { roundPrice } from '@/lib/currency-rounding';
import { convertToMultipleCurrencies } from '@/lib/services/currency';
import type { ICoupon, ICouponFixedPrice } from '@/lib/models/Coupon';

type CouponPriceFields = Pick<
  ICoupon,
  'currency' | 'fixedPrices' | 'maxDiscountPrices'
>;

export interface CouponPriceSyncResult {
  modified: boolean;
  fixedPricesAdded: number;
  maxDiscountPricesAdded: number;
}

function getBasePriceEntry(
  prices: ICouponFixedPrice[],
  preferredCurrency?: string,
): ICouponFixedPrice | undefined {
  const normalizedPreferredCurrency = preferredCurrency?.trim().toUpperCase();

  if (normalizedPreferredCurrency) {
    const preferredEntry = prices.find(
      (price) =>
        price.currencyCode.toUpperCase() === normalizedPreferredCurrency,
    );

    if (preferredEntry) {
      return preferredEntry;
    }
  }

  return prices[0];
}

async function addMissingCurrencyPrices(
  prices: ICouponFixedPrice[] | undefined,
  preferredCurrency: string | undefined,
  targetCurrencies: string[],
  roundingMap: Record<string, RoundingRule>,
): Promise<number> {
  if (!prices || prices.length === 0) {
    return 0;
  }

  const basePrice = getBasePriceEntry(prices, preferredCurrency);
  if (!basePrice) {
    return 0;
  }

  const baseCurrency = basePrice.currencyCode.toUpperCase();
  const convertedPrices = await convertToMultipleCurrencies(
    basePrice.amount,
    baseCurrency,
    targetCurrencies,
  );

  let addedCount = 0;

  for (const [currencyCode, amount] of Object.entries(convertedPrices)) {
    const normalizedCurrencyCode = currencyCode.toUpperCase();
    const alreadyExists = prices.some(
      (price) => price.currencyCode.toUpperCase() === normalizedCurrencyCode,
    );

    if (alreadyExists) {
      continue;
    }

    prices.push({
      currencyCode: normalizedCurrencyCode,
      amount: roundPrice(amount, normalizedCurrencyCode, roundingMap),
    });
    addedCount++;
  }

  return addedCount;
}

export async function syncCouponCurrencyPrices(
  coupon: CouponPriceFields,
  targetCurrencies: string[],
  roundingMap: Record<string, RoundingRule>,
): Promise<CouponPriceSyncResult> {
  const fixedPricesAdded =
    coupon.fixedPrices && coupon.fixedPrices.length > 0
      ? await addMissingCurrencyPrices(
          coupon.fixedPrices,
          coupon.currency,
          targetCurrencies,
          roundingMap,
        )
      : 0;

  const maxDiscountPricesAdded =
    coupon.maxDiscountPrices && coupon.maxDiscountPrices.length > 0
      ? await addMissingCurrencyPrices(
          coupon.maxDiscountPrices,
          coupon.currency,
          targetCurrencies,
          roundingMap,
        )
      : 0;

  return {
    modified: fixedPricesAdded > 0 || maxDiscountPricesAdded > 0,
    fixedPricesAdded,
    maxDiscountPricesAdded,
  };
}
