import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import Product from '@/lib/models/Product';
import { normalizeReservationFields } from '@/lib/reservation-fields';
import { logActivity } from '@/lib/services/logger';
import { parseJsonBody } from '@/lib/validation/http';
import { productCreateSchema } from '@/lib/validation/schemas';
import { normalizeProductMedia } from '@/lib/product-media';

export async function GET(request: NextRequest) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess('products');
    if ('error' in auth) return auth.error;

    const { searchParams } = request.nextUrl;
    const status = searchParams.get('status')?.trim().toLowerCase();

    const query: Record<string, unknown> = { isDeleted: { $ne: true } };
    if (status === 'active') {
      query.isActive = true;
    }

    const products = await Product.find(query)
      .sort({ displayOrder: 1, createdAt: -1 })
      .limit(1000)
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

    // Check if slug already exists
    const existingSlug = await Product.findOne({ slug: body.slug });
    if (existingSlug) {
      return NextResponse.json(
        { success: false, error: 'Product slug already exists' },
        { status: 409 },
      );
    }

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
