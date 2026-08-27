import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import Product from '@/lib/models/Product';
import Country from '@/lib/models/Country';
import {
  filterProductMediaForPlatform,
  normalizeProductMedia,
  parseProductPlatform,
} from '@/lib/product-media';
import { resolveProductPrices } from '@/lib/services/price-resolver';
import { normalizeCountryCode, type CountryVisibilityMode } from '@/lib/country-visibility';

const OBJECT_ID_REGEX = /^[a-f\d]{24}$/i;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await connectDB();
    const platform = parseProductPlatform(
      request.nextUrl.searchParams.get('platform'),
    );
    const viewerCountryCode = normalizeCountryCode(
      request.nextUrl.searchParams.get('viewerCountryCode'),
    );
    const { id } = await params;
    const normalizedSlug = id.trim().toLowerCase();
    const isObjectId = OBJECT_ID_REGEX.test(id.trim());
    const product = await Product.findOne({
      isActive: true,
      isDeleted: { $ne: true },
      $or: isObjectId
        ? [{ _id: id.trim() }, { slug: normalizedSlug }]
        : [{ slug: normalizedSlug }],
    }).lean();

    if (!product) {
      return NextResponse.json(
        { success: false, error: 'Product not found' },
        { status: 404 },
      );
    }

    const normalizedMedia = normalizeProductMedia(product.media);
    const filteredMedia = filterProductMediaForPlatform(
      normalizedMedia,
      platform,
    );
    const { images: _legacyImages, ...safeProduct } = product as typeof product & {
      images?: unknown;
    };
    void _legacyImages;

    const productData: Record<string, unknown> = {
      ...safeProduct,
      media: filteredMedia,
    };

    // Always resolve prices — if no viewerCountryCode, default to "EG"
    const effectiveViewerCode = viewerCountryCode || 'EG';
    const allCountries = await Country.find({ isActive: true }).lean();
    await resolveProductPrices(
      [productData],
      effectiveViewerCode,
      allCountries as unknown as Array<{
        code: string;
        currencyCode: string;
        roundingRule?: string | null;
        visibilityMode?: CountryVisibilityMode;
        countriesToSee?: unknown;
      }>,
    );

    return NextResponse.json({
      success: true,
      data: productData,
    });
  } catch (error) {
    console.error('Error fetching product:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch product' },
      { status: 500 },
    );
  }
}
