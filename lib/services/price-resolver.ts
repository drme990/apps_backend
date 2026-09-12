import { convertCurrency, getExchangeRates } from '@/lib/services/currency';
import {
  getVisibleCountriesForViewer,
  type CountryVisibilityOptions,
  type CountryVisibilityRecord,
} from '@/lib/country-visibility';
import { roundPriceByRule, type RoundingRule } from '@/lib/currency-rounding';

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
 * Safely cast a string to a RoundingRule, defaulting to 'ceil'.
 */
function toRoundingRule(rule: string | null | undefined): RoundingRule {
  const valid: RoundingRule[] = [
    'nearest-ten',
    'nearest-five',
    'nearest-fifty',
    'nearest-hundred',
    'ceil',
  ];
  return rule && (valid as string[]).includes(rule) ? (rule as RoundingRule) : 'ceil';
}

/**
 * Log a price resolution result for debugging.
 *
 * Only logs when `PRICE_DEBUG` env var is set to '1' or 'true' to avoid
 * noise in production. Logs the resolution path, target currency, and
 * final amount so discrepancies can be traced.
 */
function logPriceResolution(
  targetCurrency: string,
  path: 'exchange' | 'real-exact' | 'real-base' | 'real-convert' | 'fallback-base' | 'fallback-any' | 'none',
  amount: number,
  extra?: Record<string, unknown>,
): void {
  if (process.env.PRICE_DEBUG !== '1' && process.env.PRICE_DEBUG !== 'true') return;
  console.log('[price-resolver]', {
    targetCurrency,
    path,
    amount,
    ...extra,
  });
}

/**
 * Core price resolution for a single currency.
 *
 * Shared by both the display path (`resolveSizePrices`) and the checkout
 * path (`resolveUnitPriceWithVisibility`) to guarantee they always produce
 * the same price for the same inputs.
 *
 * Resolution order:
 *   1. Exchange price: convert from the viewer's home (main) currency
 *      using exchange rates.
 *   2. Real price: exact match in `prices[]`, or base price, or convert
 *      from base currency.
 *   3. Last-resort: try base price again, then any price entry in
 *      `prices[]`, converting if needed.
 *
 * Rounding: exchange and fallback prices use `roundPriceByRule` with the
 * currency's configured rounding rule (nearest-ten, nearest-five, etc.).
 * Real prices are returned as-is (already set by the admin).
 *
 * @param size                The product size with `prices[]`
 * @param baseCurrency        The product's base currency (e.g. "SAR")
 * @param targetCurrency      The currency to resolve (e.g. "EGP")
 * @param visibility          Country visibility settings for the target
 * @param mainCurrencyCode    The viewer's home currency (exchange base)
 * @param roundingRule        Rounding rule for the target currency
 * @param mainExchangeRates   Pre-fetched rates based on main currency
 *                            (null = fetch on demand)
 *
 * @returns `{ amount, type }` or `null` if no price could be resolved.
 */
async function resolvePriceCore(
  size: { prices?: CurrencyPriceEntry[] },
  baseCurrency: string,
  targetCurrency: string,
  visibility: CountryVisibilityOptions | undefined,
  mainCurrencyCode: string,
  roundingRule: RoundingRule,
  mainExchangeRates: Record<string, number> | null,
): Promise<{ amount: number; type: 'real' | 'exchange' } | null> {
  const target = targetCurrency.toUpperCase();
  const base = baseCurrency.toUpperCase();
  const basePrice = getBasePrice(size, base);

  // ── 1. Exchange price: convert from main (home) currency ──
  if (visibility?.exchangePrice === true) {
    const mainPriceMatch = size.prices?.find(
      (p: CurrencyPriceEntry) =>
        p.currencyCode.toUpperCase() === mainCurrencyCode,
    );

    if (mainPriceMatch && typeof mainPriceMatch.amount === 'number') {
      // Target IS the main currency — no conversion needed
      if (mainCurrencyCode === target) {
        logPriceResolution(target, 'exchange', mainPriceMatch.amount, { note: 'target=main' });
        return { amount: mainPriceMatch.amount, type: 'real' };
      }

      // Use pre-fetched rates if available, otherwise fetch fresh
      let rates = mainExchangeRates;
      if (!rates) {
        try {
          rates = await getExchangeRates(mainCurrencyCode);
        } catch {
          rates = null;
        }
      }

      if (rates && rates[target]) {
        const amount = mainPriceMatch.amount * rates[target];
        const rounded = roundPriceByRule(amount, roundingRule);
        logPriceResolution(target, 'exchange', rounded, {
          mainPrice: mainPriceMatch.amount,
          rate: rates[target],
          roundingRule,
        });
        return { amount: rounded, type: 'exchange' };
      }
    }
    // Exchange rate unavailable — fall through to real price
  }

  // ── 2. Real price: exact match, base price, or convert from base ──
  if (visibility?.realPrice !== false) {
    // 2a. Exact match in prices[]
    const exactMatch = size.prices?.find(
      (p: CurrencyPriceEntry) => p.currencyCode.toUpperCase() === target,
    );
    if (exactMatch && typeof exactMatch.amount === 'number') {
      logPriceResolution(target, 'real-exact', exactMatch.amount);
      return { amount: exactMatch.amount, type: 'real' };
    }

    // 2b. Base currency matches target — use base price
    if (base === target) {
      logPriceResolution(target, 'real-base', basePrice);
      return { amount: basePrice, type: 'real' };
    }

    // 2c. Convert from base currency to target
    if (basePrice > 0) {
      try {
        const baseRates = await getExchangeRates(base);
        const rate = baseRates[target];
        if (rate) {
          const amount = basePrice * rate;
          const rounded = roundPriceByRule(amount, roundingRule);
          logPriceResolution(target, 'real-convert', rounded, {
            basePrice,
            rate,
            roundingRule,
          });
          return { amount: rounded, type: 'exchange' };
        }
      } catch {
        // fall through to last-resort
      }
    }
  }

  // ── 3. Last-resort: try base price, then any price entry ──
  // This ensures checkout never fails just because one currency's
  // exchange rate is temporarily unavailable.
  if (basePrice > 0) {
    if (base === target) {
      logPriceResolution(target, 'fallback-base', basePrice);
      return { amount: basePrice, type: 'real' };
    }
    try {
      const baseRates = await getExchangeRates(base);
      const rate = baseRates[target];
      if (rate) {
        const amount = basePrice * rate;
        const rounded = roundPriceByRule(amount, roundingRule);
        logPriceResolution(target, 'fallback-base', rounded, {
          basePrice,
          rate,
          roundingRule,
        });
        return { amount: rounded, type: 'exchange' };
      }
    } catch {
      // can't convert — try other entries
    }
  }

  // Try any price entry in the array
  for (const entry of size.prices || []) {
    if (typeof entry.amount === 'number' && entry.amount > 0) {
      if (entry.currencyCode.toUpperCase() === target) {
        logPriceResolution(target, 'fallback-any', entry.amount, {
          sourceCurrency: entry.currencyCode,
        });
        return { amount: entry.amount, type: 'real' };
      }
      try {
        const rates = await getExchangeRates(entry.currencyCode.toUpperCase());
        const rate = rates[target];
        if (rate) {
          const amount = entry.amount * rate;
          const rounded = roundPriceByRule(amount, roundingRule);
          logPriceResolution(target, 'fallback-any', rounded, {
            sourceCurrency: entry.currencyCode,
            sourceAmount: entry.amount,
            rate,
            roundingRule,
          });
          return { amount: rounded, type: 'exchange' };
        }
      } catch {
        // skip this entry
      }
    }
  }

  logPriceResolution(target, 'none', 0);
  return null;
}

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
 * This is the checkout path. It uses the same `resolvePriceCore` as the
 * display path (`resolveSizePrices`) to guarantee price consistency.
 *
 * @param size               The product size with `prices[]`
 * @param baseCurrency       The product's base currency (e.g. "SAR")
 * @param targetCurrency     The currency to resolve the price in (e.g. "EGP")
 * @param viewerCountryCode  The viewer's home country code (e.g. "SA")
 * @param allCountries       All country records from the DB
 *
 * @returns The resolved unit price in the target currency, or 0 if unresolvable.
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

  // Find the target country's visibility settings and rounding rule
  const targetCountry = visibleCountries.find(
    (c) => c.currencyCode?.toUpperCase() === target,
  );

  const visibility: CountryVisibilityOptions | undefined =
    targetCountry?.viewerVisibility;
  const roundingRule = toRoundingRule(targetCountry?.roundingRule);

  const result = await resolvePriceCore(
    size,
    baseCurrency,
    target,
    visibility,
    mainCurrencyCode,
    roundingRule,
    null, // fetch rates on demand
  );

  return result?.amount ?? 0;
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
 * Uses the same `resolvePriceCore` as the checkout path
 * (`resolveUnitPriceWithVisibility`) to guarantee price consistency
 * between display and checkout.
 *
 * @param size               The product size with `prices[]`
 * @param baseCurrency       The product's base currency
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
  const results: ResolvedPrice[] = [];
  const seenCurrencies = new Set<string>();

  for (const country of visibleCountries) {
    const targetCurrency = country.currencyCode?.toUpperCase();
    if (!targetCurrency || seenCurrencies.has(targetCurrency)) continue;
    const visibility = country.viewerVisibility;
    if (!visibility?.realPrice && !visibility?.exchangePrice) continue;

    const roundingRule = toRoundingRule(country.roundingRule);

    const result = await resolvePriceCore(
      size,
      baseCurrency,
      targetCurrency,
      visibility,
      mainCurrencyCode,
      roundingRule,
      exchangeRates,
    );

    if (result && result.amount > 0) {
      results.push({
        currencyCode: targetCurrency,
        amount: result.amount,
        type: result.type,
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

  // Determine the viewer's home currency.
  // If the viewer country isn't in the DB (e.g. 'OT' for "Other" when
  // IP/location detection failed), fall back to the first product's
  // baseCurrency — this mirrors resolveUnitPriceWithVisibility's behavior
  // of using the product's base currency as the exchange base.
  const viewerCountry = allCountries.find(
    (c) => c.code.toUpperCase() === viewerCountryCode.toUpperCase(),
  );
  const mainCurrencyCode = viewerCountry?.currencyCode?.toUpperCase() || '';

  // Get visible countries for the viewer.
  // For unknown viewers ('OT'), getVisibleCountriesForViewer returns all
  // countries with realPrice=true, exchangePrice=true — so the user sees
  // all currencies with real prices, and exchange prices are converted
  // from the product's base currency.
  const visibleCountries = getVisibleCountriesForViewer(
    allCountries,
    viewerCountryCode,
  );

  if (visibleCountries.length === 0) {
    return products;
  }

  // Fetch exchange rates once (based on main currency if available, or
  // the first product's base currency as fallback for 'OT' viewers).
  let exchangeRates: Record<string, number> | null = null;
  const needsExchange = visibleCountries.some(
    (c) => c.viewerVisibility?.exchangePrice === true,
  );
  if (needsExchange) {
    // For unknown viewers, use the first product's base currency as the
    // exchange base. This is determined per-product in resolveSizePrices
    // via the baseCurrency parameter, so we fetch rates for the first
    // product's base currency here.
    const fallbackBase = mainCurrencyCode ||
      (products[0]?.baseCurrency as string) ||
      'SAR';
    try {
      exchangeRates = await getExchangeRates(fallbackBase);
    } catch (err) {
      console.error('[resolveProductPrices] Failed to fetch exchange rates:', err);
    }
  }

  // Resolve prices for each product's sizes
  for (const product of products) {
    const baseCurrency = (product.baseCurrency as string) || 'SAR';
    // For unknown viewers ('OT'), mainCurrencyCode is empty. The checkout
    // path (resolveUnitPriceWithVisibility) falls back to the product's
    // base currency in that case. Mirror that here so display and checkout
    // use the same exchange base, guaranteeing identical prices.
    const effectiveMainCurrencyCode = mainCurrencyCode || baseCurrency;
    // When using a per-product fallback base, the pre-fetched rates
    // (based on the first product's base) may be wrong for this product.
    // Pass null so resolvePriceCore fetches on demand with the correct base.
    const effectiveExchangeRates =
      mainCurrencyCode ? exchangeRates : null;
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
          effectiveMainCurrencyCode,
          effectiveExchangeRates,
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

    // Resolve prices for each product's add-ons (same logic as sizes)
    const addOns = product.addOns as Array<Record<string, unknown>> | undefined;
    if (addOns && Array.isArray(addOns)) {
      for (const addOn of addOns) {
        const addOnData = {
          prices: addOn.prices as CurrencyPriceEntry[] | undefined,
        };
        try {
          addOn.resolvedPrices = await resolveSizePrices(
            addOnData,
            baseCurrency,
            visibleCountries,
            effectiveMainCurrencyCode,
            effectiveExchangeRates,
          );
        } catch {
          // If resolution fails for one add-on, leave it without resolvedPrices
        }
        delete addOn.prices;
      }
    }
  }

  return products;
}
