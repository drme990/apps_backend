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

/**
 * Get the base-currency price for a size from its `prices[]` array.
 *
 * `prices[]` is the single source of truth. The base price is the entry
 * in `prices[]` whose `currencyCode` matches the product's
 * `baseCurrency`.
 *
 * @returns The base price, or 0 if not found.
 */
export function getBasePrice(
  size: { prices?: CurrencyPriceEntry[] },
  baseCurrency: string,
): number {
  const base = baseCurrency.toUpperCase();
  const match = size.prices?.find(
    (p: CurrencyPriceEntry) => p.currencyCode.toUpperCase() === base,
  );
  if (match && typeof match.amount === 'number') {
    return match.amount;
  }
  return 0;
}

type CountryRecord = CountryVisibilityRecord & {
  currencyCode: string;
  roundingRule?: string | null;
};

/**
 * A price that has been resolved for a specific currency, ready for display.
 */
export interface ResolvedPrice {
  currencyCode: string;
  amount: number;
  type: 'real' | 'exchange';
}

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
 *   2. If the product's base currency matches, use the base price from `prices[]`
 *   3. Convert the base price from `prices[]` to target via exchange rates
 *
 * NOTE: No rounding is applied here. Rounding rules are only used when
 * SETTING prices in the admin panel — never during price resolution.
 *
 * Exchange-converted prices are ceiled to the nearest integer
 * (e.g. 7053.086 → 7054) so the user never sees fractional amounts.
 * Real prices are returned as-is (already set by the admin).
 */
export async function resolveUnitPrice(
  size: { prices?: CurrencyPriceEntry[] },
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

  const basePrice = getBasePrice(size, base);
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
 *      - Fall back to the base price from `prices[]` if the target currency matches the base
 *      - Fall back to exchange rate conversion from the base currency
 *
 * NOTE: No rounding is applied here. Rounding rules are only used when
 * SETTING prices in the admin panel — never during price resolution.
 *
 * @param size               The product size with `prices[]`
 * @param baseCurrency       The product's base currency (e.g. "SAR")
 * @param targetCurrency     The currency to resolve the price in (e.g. "EGP")
 * @param viewerCountryCode  The viewer's home country code (e.g. "SA")
 * @param allCountries       All country records from the DB
 *
 * @returns The resolved unit price in the target currency.
 */
export async function resolveUnitPriceWithVisibility(
  size: { prices?: CurrencyPriceEntry[] },
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
        return mainPriceMatch.amount;
      }

      // Fetch exchange rates with the main currency as base
      try {
        const rates = await getExchangeRates(mainCurrencyCode);
        const rate = rates[target];
        if (rate) {
          return Math.ceil(mainPriceMatch.amount * rate);
        }
      } catch {
        // Exchange rate fetch failed — fall through to real price
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

    // 2. Base currency matches target — use the base price from prices[]
    const basePrice = getBasePrice(size, base);
    if (base === target) {
      return basePrice;
    }

    // 3. Convert from base currency to target via exchange rates
    if (basePrice > 0) {
      try {
        const converted = await convertCurrency(basePrice, base, target);
        return Math.ceil(converted);
      } catch {
        // Exchange rate conversion failed — fall through to any-price fallback
      }
    }
  }

  // ── Last-resort fallback: use ANY available price in prices[] ──
  // This ensures checkout never fails just because one currency's
  // exchange rate is temporarily unavailable. We try the base currency
  // price first, then any other price, converting if possible.
  const fallbackBasePrice = getBasePrice(size, base);
  if (fallbackBasePrice > 0) {
    if (base === target) return fallbackBasePrice;
    try {
      const converted = await convertCurrency(fallbackBasePrice, base, target);
      if (converted > 0) return Math.ceil(converted);
    } catch {
      // Can't convert — return base price as-is (better than failing checkout)
    }
    return fallbackBasePrice;
  }

  // Try any price entry in the array
  for (const entry of size.prices || []) {
    if (typeof entry.amount === 'number' && entry.amount > 0) {
      if (entry.currencyCode.toUpperCase() === target) return entry.amount;
      try {
        const converted = await convertCurrency(
          entry.amount,
          entry.currencyCode,
          target,
        );
        if (converted > 0) return Math.ceil(converted);
      } catch {
        // skip this entry
      }
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

/**
 * Resolve all visible currency prices for a single product size.
 *
 * Returns an array of `ResolvedPrice` entries — one per visible currency —
 * that the frontend can look up directly without doing any conversion.
 *
 * NOTE: No rounding is applied here. Rounding rules are only used when
 * SETTING prices in the admin panel — never during price resolution.
 *
 * @param size               The product size with `prices[]`
 * @param baseCurrency       The product's base currency
 * @param viewerCountryCode  The viewer's home country code (2-letter)
 * @param visibleCountries   Pre-computed visible countries for the viewer
 * @param mainCurrencyCode   The viewer's home currency (exchange base)
 * @param exchangeRates      Pre-fetched exchange rates (based on main currency)
 */
async function resolveSizePrices(
  size: { prices?: CurrencyPriceEntry[] },
  baseCurrency: string,
  visibleCountries: Array<CountryRecord & { viewerVisibility: CountryVisibilityOptions }>,
  mainCurrencyCode: string,
  exchangeRates: Record<string, number> | null,
): Promise<ResolvedPrice[]> {
  const base = baseCurrency.toUpperCase();
  const basePrice = getBasePrice(size, base);
  const results: ResolvedPrice[] = [];
  const seenCurrencies = new Set<string>();

  for (const country of visibleCountries) {
    const targetCurrency = country.currencyCode?.toUpperCase();
    if (!targetCurrency || seenCurrencies.has(targetCurrency)) continue;
    const visibility = country.viewerVisibility;
    if (!visibility?.realPrice && !visibility?.exchangePrice) continue;

    let amount = 0;
    let type: 'real' | 'exchange' = 'real';

    // 1. Exchange price: convert from main currency
    if (visibility.exchangePrice === true) {
      const mainPriceMatch = size.prices?.find(
        (p: CurrencyPriceEntry) =>
          p.currencyCode.toUpperCase() === mainCurrencyCode,
      );

      if (mainPriceMatch && typeof mainPriceMatch.amount === 'number') {
        if (mainCurrencyCode === targetCurrency) {
          amount = mainPriceMatch.amount;
          type = 'real';
        } else if (exchangeRates && exchangeRates[targetCurrency]) {
          amount = mainPriceMatch.amount * exchangeRates[targetCurrency];
          type = 'exchange';
        }
      }
    }

    // 2. Real price: use pre-defined price or convert from base
    if (amount <= 0 && visibility.realPrice !== false) {
      const exactMatch = size.prices?.find(
        (p: CurrencyPriceEntry) => p.currencyCode.toUpperCase() === targetCurrency,
      );
      if (exactMatch && typeof exactMatch.amount === 'number') {
        amount = exactMatch.amount;
        type = 'real';
      } else if (base === targetCurrency) {
        amount = basePrice;
        type = 'real';
      } else if (basePrice > 0) {
        // Convert from base currency using exchange rates
        try {
          const baseRates = await getExchangeRates(base);
          const rate = baseRates[targetCurrency];
          if (rate) {
            amount = basePrice * rate;
            type = 'exchange';
          }
        } catch {
          // Exchange rates unavailable — skip this currency
        }
      }
    }

    if (amount > 0) {
      // Exchange prices are ceiled to the nearest integer so users
      // never see fractional amounts. Real prices are returned as-is
      // (already set by the admin). Rounding rules (nearest-ten, etc.)
      // are only applied when SETTING prices in the admin panel.
      const finalAmount = type === 'exchange' ? Math.ceil(amount) : amount;
      results.push({
        currencyCode: targetCurrency,
        amount: finalAmount,
        type,
      });
      seenCurrencies.add(targetCurrency);
    }
  }

  return results;
}

/**
 * Batch-resolve prices for multiple products.
 *
 * Adds a `resolvedPrices` array to each product size containing the
 * pre-resolved price for every visible currency. The frontend can
 * look up prices directly without any conversion logic.
 *
 * @param products           Array of product objects (will be mutated)
 * @param viewerCountryCode  The viewer's home country code (2-letter)
 * @param allCountries       All country records from the DB
 * @returns The same array of products with `resolvedPrices` added to each size
 */
export async function resolveProductPrices(
  products: Record<string, unknown>[],
  viewerCountryCode: string,
  allCountries: CountryRecord[],
): Promise<Record<string, unknown>[]> {
  if (!viewerCountryCode || allCountries.length === 0) {
    return products;
  }

  // Determine the viewer's home currency
  const viewerCountry = allCountries.find(
    (c) => c.code.toUpperCase() === viewerCountryCode.toUpperCase(),
  );
  if (!viewerCountry) {
    return products;
  }

  const mainCurrencyCode = viewerCountry.currencyCode?.toUpperCase() || '';

  // Get visible countries for the viewer
  const visibleCountries = getVisibleCountriesForViewer(
    allCountries,
    viewerCountryCode,
  );

  // Fetch exchange rates once (based on main currency)
  let exchangeRates: Record<string, number> | null = null;
  const needsExchange = visibleCountries.some(
    (c) => c.viewerVisibility?.exchangePrice === true,
  );
  if (needsExchange && mainCurrencyCode) {
    try {
      exchangeRates = await getExchangeRates(mainCurrencyCode);
    } catch (err) {
      console.error('[resolveProductPrices] Failed to fetch exchange rates:', err);
    }
  }

  // Resolve prices for each product's sizes
  for (const product of products) {
    const baseCurrency = (product.baseCurrency as string) || 'SAR';
    const sizes = product.sizes as Array<Record<string, unknown>> | undefined;
    if (!sizes || !Array.isArray(sizes)) continue;

    for (const size of sizes) {
      const sizeData = {
        prices: size.prices as CurrencyPriceEntry[] | undefined,
      };
      try {
        size.resolvedPrices = await resolveSizePrices(
          sizeData,
          baseCurrency,
          visibleCountries,
          mainCurrencyCode,
          exchangeRates,
        );
      } catch {
        // If resolution fails for one size, leave it without resolvedPrices
      }
      // Strip the raw prices[] array — the frontend only needs
      // resolvedPrices[] (which contains only visible currencies).
      // This prevents exposing prices for currencies the viewer
      // shouldn't see based on country visibility settings.
      delete size.prices;
    }
  }

  return products;
}
