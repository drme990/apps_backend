import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { connectDB } from '@/lib/db';
import Product from '@/lib/models/Product';
import Country from '@/lib/models/Country';
import { isValidObjectId } from 'mongoose';
import {
    getVisibleCountriesForViewer,
    type CountryVisibilityOptions,
} from '@/lib/country-visibility';
import { getExchangeRates } from '@/lib/services/currency';
import {
    getCurrencyRoundingMap,
    roundPrice,
} from '@/lib/currency-rounding';
import { getBasePrice } from '@/lib/services/price-resolver';

const priceSchema = z.object({
    productId: z.string().trim().min(1),
    country: z.string().trim().min(1),
});

interface PriceEntry {
    countryCode: string;
    countryName: { ar: string; en: string };
    currencyCode: string;
    price: number;
    type: 'real' | 'exchange';
    isManual?: boolean;
}

function getRealPrice(
    size: {
        price?: number;
        prices: { currencyCode: string; amount: number; isManual?: boolean }[];
    },
    targetCurrency: string,
    baseCurrency: string,
): { price: number; isManual: boolean } | null {
    const upperTarget = targetCurrency.toUpperCase();
    const explicit = size.prices?.find(
        (p) => p.currencyCode.toUpperCase() === upperTarget,
    );
    if (explicit) {
        return { price: explicit.amount, isManual: explicit.isManual ?? false };
    }

    if (baseCurrency.toUpperCase() === upperTarget) {
        return { price: getBasePrice(size, baseCurrency), isManual: false };
    }

    return null;
}

async function buildPriceResponse(productId: string, country: string) {
    if (!isValidObjectId(productId)) {
        return NextResponse.json(
            { success: false, error: 'Invalid product id' },
            { status: 400 },
        );
    }

    const escapedCountry = country.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const countryQuery = {
        $or: [
            { code: country.toUpperCase() },
            { 'name.en': { $regex: `^${escapedCountry}$`, $options: 'i' } },
            { 'name.ar': { $regex: `^${escapedCountry}$`, $options: 'i' } },
        ],
    };

    const [userCountry, product, allCountries] = await Promise.all([
        Country.findOne(countryQuery).lean(),
        Product.findById(productId).lean(),
        Country.find({}).lean(),
    ]);

    if (!userCountry) {
        return NextResponse.json(
            { success: false, error: 'Country not found' },
            { status: 404 },
        );
    }

    if (!product || product.isDeleted || product.isActive === false) {
        return NextResponse.json(
            { success: false, error: 'Product not found' },
            { status: 404 },
        );
    }

    const mainCurrencyCode = userCountry.currencyCode;
    const baseCurrency = product.baseCurrency;

    const visibleCountries = getVisibleCountriesForViewer(
        allCountries,
        userCountry.code,
    );

    const needsExchange = visibleCountries.some(
        (c) => c.viewerVisibility?.exchangePrice === true,
    );

    let exchangeRates: Record<string, number> | null = null;
    if (needsExchange) {
        try {
            exchangeRates = await getExchangeRates(mainCurrencyCode);
        } catch (err) {
            console.error('Failed to fetch exchange rates for agent price:', err);
            exchangeRates = null;
        }
    }

    const roundingMap = await getCurrencyRoundingMap(
        visibleCountries.map((c) => c.currencyCode),
    );

    const sizePrices = product.sizes
        .filter((size) => size.isAvailable !== false)
        .map((size) => {
            const mainPrice = getRealPrice(size, mainCurrencyCode, baseCurrency);
            const mainAmount = mainPrice?.price ?? null;
            const prices: PriceEntry[] = [];

            for (const visibleCountry of visibleCountries) {
                const visibility = visibleCountry.viewerVisibility as CountryVisibilityOptions;
                if (!visibility?.realPrice && !visibility?.exchangePrice) continue;

                const targetCurrency = visibleCountry.currencyCode;

                // Prefer real price when enabled
                if (visibility.realPrice) {
                    const realPrice = getRealPrice(
                        size,
                        targetCurrency,
                        baseCurrency,
                    );
                    if (realPrice !== null) {
                        prices.push({
                            countryCode: visibleCountry.code,
                            countryName: visibleCountry.name,
                            currencyCode: targetCurrency,
                            price: roundPrice(realPrice.price, targetCurrency, roundingMap),
                            type: 'real',
                            isManual: realPrice.isManual,
                        });
                        continue;
                    }
                }

                // Fall back to exchange price
                if (visibility.exchangePrice && mainAmount !== null && exchangeRates) {
                    const rate = exchangeRates[targetCurrency.toUpperCase()];
                    if (rate) {
                        const converted = mainAmount * rate;
                        prices.push({
                            countryCode: visibleCountry.code,
                            countryName: visibleCountry.name,
                            currencyCode: targetCurrency,
                            price: roundPrice(converted, targetCurrency, roundingMap),
                            type: 'exchange',
                        });
                    }
                }
            }

            return {
                sizeId: String(size._id),
                sizeName: size.name,
                available: size.isAvailable !== false,
                prices,
            };
        });

    return NextResponse.json({
        success: true,
        data: {
            productId: String(product._id),
            productName: product.name,
            slug: product.slug,
            countryCode: userCountry.code,
            countryName: userCountry.name,
            mainCurrencyCode,
            baseCurrency,
            sizes: sizePrices,
        },
    });
}

export async function GET(request: NextRequest) {
    try {
        await connectDB();

        const { searchParams } = new URL(request.url);
        const raw = {
            productId: searchParams.get('productId'),
            country: searchParams.get('country'),
        };

        if (!raw.productId) {
            return NextResponse.json(
                { success: false, error: 'productId is required' },
                { status: 400 },
            );
        }

        if (!raw.country) {
            return NextResponse.json(
                { success: false, error: 'country is required' },
                { status: 400 },
            );
        }

        const parsed = priceSchema.safeParse(raw);
        if (!parsed.success) {
            return NextResponse.json(
                { success: false, error: 'Invalid productId or country' },
                { status: 400 },
            );
        }

        return buildPriceResponse(parsed.data.productId, parsed.data.country);
    } catch (error) {
        console.error('Error fetching agent product price:', error);
        return NextResponse.json(
            { success: false, error: 'Failed to fetch product price' },
            { status: 500 },
        );
    }
}

export async function POST(request: NextRequest) {
    try {
        await connectDB();

        let body: unknown = null;
        try {
            body = (await request.json()) as unknown;
        } catch {
            body = null;
        }

        const { searchParams } = new URL(request.url);
        const raw = {
            productId:
                body &&
                    typeof body === 'object' &&
                    'productId' in body &&
                    typeof body.productId === 'string'
                    ? body.productId
                    : searchParams.get('productId'),
            country:
                body &&
                    typeof body === 'object' &&
                    'country' in body &&
                    typeof body.country === 'string'
                    ? body.country
                    : searchParams.get('country'),
        };

        if (!raw.productId) {
            return NextResponse.json(
                { success: false, error: 'productId is required' },
                { status: 400 },
            );
        }

        if (!raw.country) {
            return NextResponse.json(
                { success: false, error: 'country is required' },
                { status: 400 },
            );
        }

        const parsed = priceSchema.safeParse(raw);
        if (!parsed.success) {
            return NextResponse.json(
                { success: false, error: 'Invalid productId or country' },
                { status: 400 },
            );
        }

        return buildPriceResponse(parsed.data.productId, parsed.data.country);
    } catch (error) {
        console.error('Error fetching agent product price:', error);
        return NextResponse.json(
            { success: false, error: 'Failed to fetch product price' },
            { status: 500 },
        );
    }
}
