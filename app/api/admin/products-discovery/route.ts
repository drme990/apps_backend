import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import Product from '@/lib/models/Product';
import Country from '@/lib/models/Country';
import { normalizeReservationFields } from '@/lib/reservation-fields';
import { normalizeProductMedia } from '@/lib/product-media';
import { resolveProductPrices } from '@/lib/services/price-resolver';
import { normalizeCountryCode, type CountryVisibilityMode } from '@/lib/country-visibility';

export async function GET(request: NextRequest) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess('products-discovery');
    if ('error' in auth) return auth.error;

    const { searchParams } = new URL(request.url);
    const limitParam = Number(searchParams.get('limit'));
    const limit =
      Number.isFinite(limitParam) && limitParam > 0 ? limitParam : 1000;

    // Optional viewerCountryCode — when set, prices are resolved exactly
    // as the public apps would see them for that country (real vs exchange,
    // visibility rules, etc). When absent, raw prices[] are returned.
    const viewerCountryCode = normalizeCountryCode(
      searchParams.get('viewerCountryCode'),
    );

    const products = await Product.find({ isDeleted: { $ne: true } })
      .sort({ displayOrder: 1, createdAt: -1 })
      .limit(limit)
      .lean();

    const normalizedProducts = products.map((product) => {
      const productWithLegacy = product as typeof product & {
        images?: unknown;
      };
      const safeProduct = { ...productWithLegacy };
      delete safeProduct.images;
      return {
        ...safeProduct,
        media: normalizeProductMedia(product.media),
        reservationFields: normalizeReservationFields(
          product.reservationFields,
        ),
      };
    });

    // If a viewer country is specified, resolve prices exactly as the
    // public apps would see them — same visibility rules, exchange rates,
    // real vs exchange classification.
    if (viewerCountryCode) {
      const allCountries = await Country.find({ isActive: true }).lean();
      await resolveProductPrices(
        normalizedProducts as Record<string, unknown>[],
        viewerCountryCode,
        allCountries as unknown as Array<{
          code: string;
          currencyCode: string;
          roundingRule?: string | null;
          visibilityMode?: CountryVisibilityMode;
          countriesToSee?: unknown;
        }>,
      );
    }

    return NextResponse.json({
      success: true,
      data: {
        products: normalizedProducts,
      },
    });
  } catch (error) {
    console.error('Error fetching products discovery:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch products' },
      { status: 500 },
    );
  }
}
