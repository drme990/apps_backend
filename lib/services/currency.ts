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

function getRelativeDateString(daysAgo: number): string {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

async function fetchExchangeRatesForDate(
  baseCurrency: string,
  releaseDate: string,
): Promise<Record<string, number>> {
  const response = await fetch(
    `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${releaseDate}/v1/currencies/${baseCurrency}.json`,
  );

  if (!response.ok) {
    const message = `Exchange rate API returned ${response.status}`;
    throw new Error(message);
  }

  const data = (await response.json()) as ExchangeRateResponse;
  const rates = data[baseCurrency] as Record<string, number>;

  if (!rates || typeof rates !== 'object') {
    throw new Error(`Invalid exchange rate data format for ${baseCurrency}`);
  }

  const normalizedRates: Record<string, number> = {};
  for (const [currency, rate] of Object.entries(rates)) {
    normalizedRates[currency.toUpperCase()] = rate;
  }

  return normalizedRates;
}

export async function getExchangeRates(
  baseCurrency: string,
): Promise<Record<string, number>> {
  const currencyKey = baseCurrency.toLowerCase();
  const today = getTodayDateString();
  const yesterday = getRelativeDateString(1);
  const candidates = [today, yesterday];

  for (const releaseDate of candidates) {
    const cacheKey = `${currencyKey}:${releaseDate}`;
    const cached = cache.get(cacheKey);

    if (cached && cached.expiry > Date.now()) {
      return cached.data;
    }

    try {
      const rates = await fetchExchangeRatesForDate(currencyKey, releaseDate);

      cache.set(cacheKey, {
        data: rates,
        expiry: Date.now() + CACHE_TTL_MS,
      });
      return rates;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        releaseDate === today &&
        message.includes("Couldn't find the requested release version")
      ) {
        console.warn(
          `Exchange rate release ${today} unavailable for ${currencyKey}; retrying ${yesterday}`,
        );
        continue;
      }

      console.error('Error fetching exchange rates:', error);
      if (cached) return cached.data;

      if (releaseDate === today) {
        continue;
      }

      throw error;
    }
  }

  throw new Error(
    `Unable to fetch exchange rates for ${currencyKey} on ${today} or ${yesterday}`,
  );
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
