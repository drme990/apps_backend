import Country from '@/lib/models/Country';

/**
 * Currency-specific rounding rules for auto-calculated prices.
 *
 * Rules are configured in countries data and resolved by currency code.
 */

export type RoundingRule = 'nearest-ten' | 'nearest-five' | 'ceil';

type CountryWithRounding = {
  currencyCode: string;
  roundingRule?: RoundingRule | null;
};

export function roundPriceByRule(
  amount: number,
  rule: RoundingRule = 'ceil',
): number {
  switch (rule) {
    case 'nearest-ten':
      return Math.ceil(amount / 10) * 10;
    case 'nearest-five':
      return Math.ceil(amount / 5) * 5;
    case 'ceil':
    default:
      return Math.ceil(amount);
  }
}

export function buildCurrencyRoundingMap(
  countries: CountryWithRounding[],
): Record<string, RoundingRule> {
  const map: Record<string, RoundingRule> = {};

  for (const country of countries) {
    const code = country.currencyCode?.toUpperCase();
    if (!code || map[code]) continue;
    map[code] = country.roundingRule ?? 'ceil';
  }

  return map;
}

export async function getCurrencyRoundingMap(
  currencyCodes?: string[],
): Promise<Record<string, RoundingRule>> {
  const normalizedCodes = currencyCodes
    ?.map((code) => code.toUpperCase())
    .filter(Boolean);

  const query = normalizedCodes?.length
    ? { currencyCode: { $in: normalizedCodes } }
    : {};

  const countries = (await Country.find(query)
    .select('currencyCode roundingRule')
    .lean()) as CountryWithRounding[];

  return buildCurrencyRoundingMap(countries);
}

/** Apply the rounding rule for the given currency code. */
export function roundPrice(
  amount: number,
  currencyCode: string,
  roundingMap?: Record<string, RoundingRule>,
): number {
  const rule = roundingMap?.[currencyCode.toUpperCase()] ?? 'ceil';
  return roundPriceByRule(amount, rule);
}
