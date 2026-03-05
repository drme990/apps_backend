interface ExchangeRateResponse {
  date: string;
  [currencyCode: string]: string | Record<string, number>;
}

const cache: Map<string, { data: Record<string, number>; expiry: number }> =
  new Map();
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

export async function getExchangeRates(
  baseCurrency: string,
): Promise<Record<string, number>> {
  const key = baseCurrency.toLowerCase();
  const cached = cache.get(key);

  if (cached && cached.expiry > Date.now()) return cached.data;

  try {
    const res = await fetch(
      `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/${key}.json`,
    );

    if (!res.ok) throw new Error(`Exchange rate API returned ${res.status}`);

    const data = (await res.json()) as ExchangeRateResponse;
    const rates = data[key] as Record<string, number>;

    if (!rates || typeof rates !== 'object') {
      throw new Error(`Invalid exchange rate data format for ${key}`);
    }

    const normalizedRates: Record<string, number> = {};
    for (const [currency, rate] of Object.entries(rates)) {
      normalizedRates[currency.toUpperCase()] = rate;
    }

    cache.set(key, {
      data: normalizedRates,
      expiry: Date.now() + CACHE_TTL_MS,
    });
    return normalizedRates;
  } catch (error) {
    console.error('Error fetching exchange rates:', error);
    if (cached) return cached.data;
    throw error;
  }
}

export async function convertCurrency(
  amount: number,
  fromCurrency: string,
  toCurrency: string,
): Promise<number> {
  if (fromCurrency.toUpperCase() === toCurrency.toUpperCase()) return amount;

  const rates = await getExchangeRates(fromCurrency.toUpperCase());
  const rate = rates[toCurrency.toUpperCase()];

  if (!rate)
    throw new Error(
      `No exchange rate found for ${fromCurrency} → ${toCurrency}`,
    );

  return Math.round(amount * rate * 100) / 100;
}

export async function convertToMultipleCurrencies(
  amount: number,
  baseCurrency: string,
  targetCurrencies: string[],
): Promise<Record<string, number>> {
  const rates = await getExchangeRates(baseCurrency.toUpperCase());
  const result: Record<string, number> = {};

  for (const target of targetCurrencies) {
    const code = target.toUpperCase();
    if (code === baseCurrency.toUpperCase()) {
      result[code] = amount;
    } else if (rates[code]) {
      result[code] = Math.round(amount * rates[code] * 100) / 100;
    }
  }

  return result;
}
