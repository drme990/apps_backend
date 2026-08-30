import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import Product from '@/lib/models/Product';
import Country from '@/lib/models/Country';
import { normalizeReservationFields } from '@/lib/reservation-fields';
import {
  filterProductMediaForPlatform,
  normalizeProductMedia,
  parseProductPlatform,
} from '@/lib/product-media';
import { resolveProductPrices } from '@/lib/services/price-resolver';
import { stripProductsForPublic } from '@/lib/product-public-mapper';
import { normalizeCountryCode, type CountryVisibilityMode } from '@/lib/country-visibility';
import { getClientCountry } from '@/lib/utils/ip';

export async function GET(request: NextRequest) {
  try {
    await connectDB();

    const { searchParams } = request.nextUrl;
    const limit = parseInt(searchParams.get('limit') || '50');
    const page = parseInt(searchParams.get('page') || '1');
    const inStock = searchParams.get('inStock');
    const sacrifice = searchParams.get('sacrifice');
    const platform = parseProductPlatform(searchParams.get('platform'));
    const viewerCountryCode = normalizeCountryCode(
      searchParams.get('viewerCountryCode'),
    );

    const query: Record<string, unknown> = {
      isActive: true,
      isDeleted: { $ne: true },
    };
    if (inStock !== null) query.inStock = inStock === 'true';
    if (sacrifice === 'true') query.workAsSacrifice = true;

    const skip = (page - 1) * limit;

    const products = await Product.find(query)
      .sort({ displayOrder: 1, createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    const total = await Product.countDocuments(query);
    const totalPages = Math.ceil(total / limit);

    // Normalize product media and reservation fields
    const normalizedProducts = products.map((product) => {
      const { images: _legacyImages, ...safeProduct } = product as typeof product & {
        images?: unknown;
      };
      void _legacyImages;
      return {
        ...safeProduct,
        media: filterProductMediaForPlatform(
          normalizeProductMedia(product.media),
          platform,
        ),
        reservationFields: normalizeReservationFields(
          product.reservationFields,
        ),
      };
    });

    // Resolve prices for public apps (platform is set).
    // Admin panel (no platform) gets raw prices[] for editing.
    if (platform) {
      // Use the viewerCountryCode from the query string, or fall back to
      // IP-based country detection from request headers (CF/Vercel).
      // If neither is available, use 'OT' (Other) — the user will see
      // all currencies with real prices, but no exchange conversion
      // (since there's no home country to convert from).
      const effectiveViewerCode = viewerCountryCode || normalizeCountryCode(getClientCountry(request)) || 'OT';
      const allCountries = await Country.find({ isActive: true }).lean();
      await resolveProductPrices(
        normalizedProducts as Record<string, unknown>[],
        effectiveViewerCode,
        allCountries as unknown as Array<{
          code: string;
          currencyCode: string;
          roundingRule?: string | null;
          visibilityMode?: CountryVisibilityMode;
          countriesToSee?: unknown;
        }>,
      );
      // Strip admin-only fields not needed by the frontend
      stripProductsForPublic(normalizedProducts as Record<string, unknown>[]);
    }

    return NextResponse.json({
      success: true,
      data: {
        products: normalizedProducts,
        pagination: {
          currentPage: page,
          totalPages,
          totalProducts: total,
          hasNextPage: page < totalPages,
          hasPrevPage: page > 1,
        },
      },
    });
  } catch (error) {
    console.error('Error fetching products:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch products' },
      { status: 500 },
    );
  }
}
