import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import Product from '@/lib/models/Product';
import { normalizeReservationFields } from '@/lib/reservation-fields';
import { logActivity } from '@/lib/services/logger';
import { parseJsonBody } from '@/lib/validation/http';
import { productCreateSchema } from '@/lib/validation/schemas';
import { normalizeProductMedia } from '@/lib/product-media';

export async function GET() {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess('products');
    if ('error' in auth) return auth.error;

    const products = await Product.find({ isDeleted: { $ne: true } })
      .sort({ displayOrder: 1, createdAt: -1 })
      .limit(1000)
      .lean();
    return NextResponse.json({
      success: true,
      data: {
        products: products.map((product) => ({
          ...(() => {
            const { images: _legacyImages, ...safeProduct } =
              product as Partial<Record<'images', unknown>> &
                Record<string, unknown>;
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
    console.error('Error fetching products:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch products' },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess('products');
    if ('error' in auth) return auth.error;

    const parsed = await parseJsonBody(request, productCreateSchema);
    if (!parsed.success) return parsed.response;
    const body = parsed.data;
    const normalizedMedia = normalizeProductMedia(body.media);
    const product = await Product.create({
      ...body,
      media: normalizedMedia,
      reservationFields: normalizeReservationFields(body.reservationFields),
    });

    const productObject = product.toObject();
    const responseMedia = normalizeProductMedia(productObject.media);

    await logActivity({
      userId: auth.user.userId,
      userName: auth.user.name,
      userEmail: auth.user.email,
      action: 'create',
      resource: 'product',
      resourceId: product._id.toString(),
      details: `Created product: ${product.name.en || product.name.ar}`,
    });

    return NextResponse.json(
      {
        success: true,
        data: {
          ...productObject,
          media: responseMedia,
        },
      },
      { status: 201 },
    );
  } catch (error) {
    console.error('Error creating product:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to create product' },
      { status: 500 },
    );
  }
}
