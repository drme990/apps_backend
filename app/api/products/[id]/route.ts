import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import Product from '@/lib/models/Product';
import {
  filterProductMediaForPlatform,
  normalizeProductMedia,
  parseProductPlatform,
} from '@/lib/product-media';

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
    const productWithLegacy = product as typeof product & {
      images?: unknown;
    };
    const { images: _legacyImages, ...safeProduct } = productWithLegacy;

    return NextResponse.json({
      success: true,
      data: {
        ...safeProduct,
        media: filteredMedia,
      },
    });
  } catch (error) {
    console.error('Error fetching product:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch product' },
      { status: 500 },
    );
  }
}
