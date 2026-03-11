interface ExchangeRateResponse {
  date: string;
  [currencyCode: string]: string | Record<string, number>;
}

const cache: Map<string, { data: Record<string, number>; expiry: number }> =
  new Map();
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

function getTodayDateString(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export async function getExchangeRates(
  baseCurrency: string,
): Promise<Record<string, number>> {
  const currencyKey = baseCurrency.toLowerCase();
  const today = getTodayDateString();
  const cacheKey = `${currencyKey}:${today}`;
  const cached = cache.get(cacheKey);

  if (cached && cached.expiry > Date.now()) return cached.data;

  try {
    const res = await fetch(
      `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${today}/v1/currencies/${currencyKey}.json`,
    );

    if (!res.ok) throw new Error(`Exchange rate API returned ${res.status}`);

    const data = (await res.json()) as ExchangeRateResponse;
    const rates = data[currencyKey] as Record<string, number>;

    if (!rates || typeof rates !== 'object') {
      throw new Error(`Invalid exchange rate data format for ${currencyKey}`);
    }

    const normalizedRates: Record<string, number> = {};
    for (const [currency, rate] of Object.entries(rates)) {
      normalizedRates[currency.toUpperCase()] = rate;
    }

    cache.set(cacheKey, {
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
