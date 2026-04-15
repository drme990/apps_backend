import { NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'crypto';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import Product from '@/lib/models/Product';
import { normalizeReservationFields } from '@/lib/reservation-fields';
import { normalizeProductMedia } from '@/lib/product-media';
import { logActivity } from '@/lib/services/logger';

function sanitizeBaseSlug(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-\s]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  return normalized || 'product';
}

async function generateUniqueDuplicateSlug(baseSlug: string): Promise<string> {
  const safeBaseSlug = sanitizeBaseSlug(baseSlug);

  for (let attempt = 0; attempt < 40; attempt += 1) {
    const suffix = randomBytes(3).toString('hex');
    const candidate = `${safeBaseSlug}-${suffix}`;
    const existing = await Product.exists({ slug: candidate });

    if (!existing) {
      return candidate;
    }
  }

  throw new Error('Unable to generate a unique slug for duplicated product');
}

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess('products');
    if ('error' in auth) return auth.error;

    const { id } = await params;
    const sourceProduct = await Product.findOne({
      _id: id,
      isDeleted: { $ne: true },
    });

    if (!sourceProduct) {
      return NextResponse.json(
        { success: false, error: 'Product not found' },
        { status: 404 },
      );
    }

    const sourceObject = sourceProduct.toObject() as unknown as Record<
      string,
      unknown
    >;
    const basePayload: Record<string, unknown> = { ...sourceObject };
    delete basePayload._id;
    delete basePayload.__v;
    delete basePayload.createdAt;
    delete basePayload.updatedAt;

    const duplicatedSlug = await generateUniqueDuplicateSlug(
      sourceProduct.slug,
    );

    const highestOrderProduct = await Product.findOne({
      isDeleted: { $ne: true },
    })
      .sort({ displayOrder: -1 })
      .select('displayOrder')
      .lean();

    const nextDisplayOrder =
      typeof highestOrderProduct?.displayOrder === 'number'
        ? highestOrderProduct.displayOrder + 1
        : 0;

    const duplicatedProduct = await Product.create({
      ...basePayload,
      slug: duplicatedSlug,
      displayOrder: nextDisplayOrder,
      isDeleted: false,
      deletedAt: null,
      deletedBy: null,
    });

    await logActivity({
      userId: auth.user.userId,
      userName: auth.user.name,
      userEmail: auth.user.email,
      action: 'create',
      resource: 'product',
      resourceId: duplicatedProduct._id.toString(),
      details: `Duplicated product: ${sourceProduct.name.en || sourceProduct.name.ar} (${sourceProduct._id.toString()} -> ${duplicatedProduct._id.toString()})`,
    });

    const duplicatedObject = duplicatedProduct.toObject();
    return NextResponse.json({
      success: true,
      data: {
        ...duplicatedObject,
        media: normalizeProductMedia(duplicatedObject.media),
        reservationFields: normalizeReservationFields(
          duplicatedObject.reservationFields,
        ),
      },
    });
  } catch (error) {
    console.error('Error duplicating product:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to duplicate product' },
      { status: 500 },
    );
  }
}
