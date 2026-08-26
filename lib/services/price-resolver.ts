import { convertCurrency } from '@/lib/services/currency';
interface CurrencyPriceEntry {
  currencyCode: string;
  amount: number;
}

/**
 * Currencies supported by the payment gateway (EasyKash).
 * If the user's selected currency is not in this list, the order
 * payment is created in EGP instead.
 */
export const PAYMENT_GATEWAY_CURRENCIES = ['EGP', 'USD', 'SAR', 'EUR'] as const;

/**
 * Resolve the unit price for a product size in the requested currency.
 *
 * Resolution order:
 *   1. Exact match in `size.prices[]` for the requested currency
 *   2. If the product's base currency matches the requested currency,
 *      use `size.price` (the default price field)
 *   3. Convert `size.price` (in base currency) to the requested currency
 *      using live exchange rates
 *
 * This function NEVER throws for a missing currency price — it converts
 * via exchange rates instead. It only throws if the exchange rate API
 * fails AND no fallback price is available.
 *
 * @returns The resolved unit price in the requested currency.
 */
export async function resolveUnitPrice(
  size: { price?: number; prices?: CurrencyPriceEntry[] },
  baseCurrency: string,
  targetCurrency: string,
): Promise<number> {
  const target = targetCurrency.toUpperCase();
  const base = baseCurrency.toUpperCase();

  // 1. Exact match in the prices array
  const exactMatch = size.prices?.find(
    (p: CurrencyPriceEntry) => p.currencyCode.toUpperCase() === target,
  );
  if (exactMatch && typeof exactMatch.amount === 'number') {
    return exactMatch.amount;
  }

  // 2. Base currency matches target — use the default price field
  const basePrice = size.price ?? 0;
  if (base === target) {
    return basePrice;
  }

  // 3. Convert from base currency to target via exchange rates
  if (basePrice > 0) {
    const converted = await convertCurrency(basePrice, base, target);
    return Math.ceil(converted);
  }

  return 0;
}

/**
 * Resolve the payment currency for the payment gateway.
 *
 * If the user's selected currency is supported by the payment gateway,
 * use it directly. Otherwise, fall back to EGP.
 *
 * @returns The currency code to use for the payment gateway.
 */
export function resolvePaymentCurrency(userCurrency: string): string {
  const upper = userCurrency.toUpperCase();
  return PAYMENT_GATEWAY_CURRENCIES.includes(upper as (typeof PAYMENT_GATEWAY_CURRENCIES)[number])
    ? upper
    : 'EGP';
}

/**
 * Convert an amount from the user's currency to the payment gateway
 * currency, using live exchange rates.
 *
 * If the user's currency is already supported by the gateway, returns
 * the amount as-is. Otherwise, converts to EGP.
 *
 * @returns `{ amount, currency }` — the amount and currency to send
 *          to the payment gateway.
 */
export async function convertToPaymentCurrency(
  amount: number,
  userCurrency: string,
): Promise<{ amount: number; currency: string }> {
  const paymentCurrency = resolvePaymentCurrency(userCurrency);

  if (paymentCurrency === userCurrency.toUpperCase()) {
    return { amount: Math.ceil(amount), currency: paymentCurrency };
  }

  const converted = await convertCurrency(
    amount,
    userCurrency.toUpperCase(),
    paymentCurrency,
  );

  return { amount: Math.ceil(converted), currency: paymentCurrency };
}
