import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import Product from '@/lib/models/Product';
import { normalizeReservationFields } from '@/lib/reservation-fields';
import { normalizeProductMedia } from '@/lib/product-media';

export async function GET(request: NextRequest) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess('products-discovery');
    if ('error' in auth) return auth.error;

    const { searchParams } = new URL(request.url);
    const limitParam = Number(searchParams.get('limit'));
    const limit =
      Number.isFinite(limitParam) && limitParam > 0 ? limitParam : 1000;

    const products = await Product.find({ isDeleted: { $ne: true } })
      .sort({ displayOrder: 1, createdAt: -1 })
      .limit(limit)
      .lean();

    return NextResponse.json({
      success: true,
      data: {
        products: products.map((product) => ({
          ...(() => {
            const productWithLegacy = product as typeof product & {
              images?: unknown;
            };
            const safeProduct = {
              ...productWithLegacy,
            };
            delete safeProduct.images;
            return safeProduct;
          })(),
          media: normalizeProductMedia(product.media),
          reservationFields: normalizeReservationFields(
            product.reservationFields,
          ),
        })),
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
