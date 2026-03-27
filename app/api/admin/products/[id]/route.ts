import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import Product from '@/lib/models/Product';
import { normalizeReservationFields } from '@/lib/reservation-fields';
import { logActivity } from '@/lib/services/logger';
import { parseJsonBody } from '@/lib/validation/http';
import { productUpdateSchema } from '@/lib/validation/schemas';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess('products');
    if ('error' in auth) return auth.error;

    const { id } = await params;
    const product = await Product.findOne({
      _id: id,
      isDeleted: { $ne: true },
    }).lean();
    if (!product) {
      return NextResponse.json(
        { success: false, error: 'Product not found' },
        { status: 404 },
      );
    }
    return NextResponse.json({
      success: true,
      data: {
        ...product,
        reservationFields: normalizeReservationFields(
          product.reservationFields,
        ),
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

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess('products');
    if ('error' in auth) return auth.error;

    const { id } = await params;
    const parsed = await parseJsonBody(request, productUpdateSchema);
    if (!parsed.success) return parsed.response;
    const body = parsed.data;

    // Use findById + set + save for reliable nested array updates (e.g. reservationFields)
    const doc = await Product.findOne({ _id: id, isDeleted: { $ne: true } });
    if (!doc) {
      return NextResponse.json(
        { success: false, error: 'Product not found' },
        { status: 404 },
      );
    }
    doc.set({
      ...body,
      reservationFields: normalizeReservationFields(body.reservationFields),
    });
    const product = await doc.save();

    await logActivity({
      userId: auth.user.userId,
      userName: auth.user.name,
      userEmail: auth.user.email,
      action: 'update',
      resource: 'product',
      resourceId: product._id.toString(),
      details: `Updated product: ${product.name.en || product.name.ar}`,
    });
    return NextResponse.json({
      success: true,
      data: {
        ...product.toObject(),
        reservationFields: normalizeReservationFields(
          product.reservationFields,
        ),
      },
    });
  } catch (error) {
    console.error('Error updating product:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to update product' },
      { status: 500 },
    );
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess('products');
    if ('error' in auth) return auth.error;

    const { id } = await params;
    const product = await Product.findOne({
      _id: id,
      isDeleted: { $ne: true },
    });
    if (!product) {
      return NextResponse.json(
        { success: false, error: 'Product not found' },
        { status: 404 },
      );
    }

    product.isDeleted = true;
    product.isActive = false;
    product.deletedAt = new Date();
    product.deletedBy = {
      userId: auth.user.userId,
      userName: auth.user.name,
      userEmail: auth.user.email,
    };
    await product.save();

    await logActivity({
      userId: auth.user.userId,
      userName: auth.user.name,
      userEmail: auth.user.email,
      action: 'delete',
      resource: 'product',
      resourceId: id,
      details: `Soft deleted product: ${product.name.en || product.name.ar}`,
    });

    return NextResponse.json({
      success: true,
      message: 'Product archived successfully',
    });
  } catch (error) {
    console.error('Error deleting product:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to delete product' },
      { status: 500 },
    );
  }
}
