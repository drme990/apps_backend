import { convertCurrency, getExchangeRates } from '@/lib/services/currency';
import {
  getVisibleCountriesForViewer,
  type CountryVisibilityOptions,
  type CountryVisibilityRecord,
} from '@/lib/country-visibility';

interface CurrencyPriceEntry {
  currencyCode: string;
  amount: number;
}

type CountryRecord = CountryVisibilityRecord & {
  currencyCode: string;
};

/**
 * Currencies supported by the payment gateway (EasyKash).
 * If the user's selected currency is not in this list, the order
 * payment is created in EGP instead.
 */
export const PAYMENT_GATEWAY_CURRENCIES = ['EGP', 'USD', 'SAR', 'EUR'] as const;

/**
 * Simple price resolution WITHOUT country visibility settings.
 * Used by admin routes where the admin manually sets prices.
 *
 * Resolution order:
 *   1. Exact match in `size.prices[]` for the requested currency
 *   2. If the product's base currency matches, use `size.price`
 *   3. Convert `size.price` from base currency to target via exchange rates
 */
export async function resolveUnitPrice(
  size: { price?: number; prices?: CurrencyPriceEntry[] },
  baseCurrency: string,
  targetCurrency: string,
): Promise<number> {
  const target = targetCurrency.toUpperCase();
  const base = baseCurrency.toUpperCase();

  const exactMatch = size.prices?.find(
    (p: CurrencyPriceEntry) => p.currencyCode.toUpperCase() === target,
  );
  if (exactMatch && typeof exactMatch.amount === 'number') {
    return exactMatch.amount;
  }

  const basePrice = size.price ?? 0;
  if (base === target) {
    return basePrice;
  }

  if (basePrice > 0) {
    const converted = await convertCurrency(basePrice, base, target);
    return Math.ceil(converted);
  }

  return 0;
}

/**
 * Resolve the unit price for a product size in the requested currency,
 * respecting the country visibility settings (realPrice vs exchangePrice).
 *
 * This mirrors the frontend's `usePriceInCurrency` hook logic:
 *
 *   1. If the target country has `exchangePrice: true`:
 *      - Find the price in the viewer's home currency (mainCurrencyCode)
 *      - Convert to the target currency via exchange rates
 *
 *   2. If the target country has `realPrice: true` (or exchangePrice is false):
 *      - Use the pre-defined price for the target currency from `size.prices[]`
 *      - Fall back to `size.price` if the target currency matches the base
 *      - Fall back to exchange rate conversion from the base currency
 *
 * @param size               The product size with `price` and `prices[]`
 * @param baseCurrency       The product's base currency (e.g. "SAR")
 * @param targetCurrency     The currency to resolve the price in (e.g. "EGP")
 * @param viewerCountryCode  The viewer's home country code (e.g. "SA")
 * @param allCountries       All country records from the DB
 *
 * @returns The resolved unit price in the target currency.
 */
export async function resolveUnitPriceWithVisibility(
  size: { price?: number; prices?: CurrencyPriceEntry[] },
  baseCurrency: string,
  targetCurrency: string,
  viewerCountryCode: string,
  allCountries: CountryRecord[],
): Promise<number> {
  const target = targetCurrency.toUpperCase();
  const base = baseCurrency.toUpperCase();

  // Determine the viewer's home currency (the "main" currency for exchange)
  const viewerCountry = allCountries.find(
    (c) => c.code.toUpperCase() === viewerCountryCode.toUpperCase(),
  );
  const mainCurrencyCode = viewerCountry?.currencyCode?.toUpperCase() || base;

  // Get visibility settings for all countries from the viewer's perspective
  const visibleCountries = getVisibleCountriesForViewer(
    allCountries,
    viewerCountryCode,
  );

  // Find the target country's visibility settings
  // The target country is the one whose currency matches the target currency
  const targetCountry = visibleCountries.find(
    (c) => c.currencyCode?.toUpperCase() === target,
  );

  const visibility: CountryVisibilityOptions | undefined =
    targetCountry?.viewerVisibility;

  // If exchangePrice is enabled for this country, convert from the main currency
  if (visibility?.exchangePrice === true) {
    // Find the price in the main currency (the viewer's home currency)
    const mainPriceMatch = size.prices?.find(
      (p: CurrencyPriceEntry) =>
        p.currencyCode.toUpperCase() === mainCurrencyCode,
    );

    if (mainPriceMatch && typeof mainPriceMatch.amount === 'number') {
      // If the target IS the main currency, no conversion needed
      if (mainCurrencyCode === target) {
        return Math.ceil(mainPriceMatch.amount);
      }

      // Fetch exchange rates with the main currency as base
      const rates = await getExchangeRates(mainCurrencyCode);
      const rate = rates[target];
      if (rate) {
        return Math.ceil(mainPriceMatch.amount * rate);
      }
    }

    // If no main currency price or exchange rate, fall through to real price
  }

  // Use real price (pre-defined price for the target currency)
  if (visibility?.realPrice !== false) {
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
