import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import Category from '@/lib/models/Categories';
import Product from '@/lib/models/Product';
import { logActivity } from '@/lib/services/logger';
import { parseJsonBody } from '@/lib/validation/http';
import { categoryUpdateSchema } from '@/lib/validation/schemas';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess('categories');
    if ('error' in auth) return auth.error;

    const { id } = await params;
    const category = await Category.findById(id)
      .populate('products', '_id name slug')
      .lean();

    if (!category) {
      return NextResponse.json(
        { success: false, error: 'Category not found' },
        { status: 404 },
      );
    }

    return NextResponse.json({ success: true, data: category });
  } catch (error) {
    console.error('Error fetching category:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch category' },
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
    const auth = await requireAdminPageAccess('categories');
    if ('error' in auth) return auth.error;

    const { id } = await params;
    const parsed = await parseJsonBody(request, categoryUpdateSchema);
    if (!parsed.success) return parsed.response;
    const body = parsed.data;

    if (body.categoryNumber !== undefined) {
      const existing = await Category.findOne({
        categoryNumber: body.categoryNumber,
        _id: { $ne: id },
      });
      if (existing) {
        return NextResponse.json(
          { success: false, error: 'Category number already exists' },
          { status: 409 },
        );
      }
    }

    if (body.products && body.products.length > 0) {
      const conflicting = await Category.findOne({
        _id: { $ne: id },
        products: { $in: body.products },
      }).lean();
      if (conflicting) {
        return NextResponse.json(
          { success: false, error: 'One or more products are already assigned to another category' },
          { status: 409 },
        );
      }
    }

    const category = await Category.findByIdAndUpdate(id, body, {
      returnDocument: 'after',
      runValidators: true,
    })
      .populate('products', '_id name slug')
      .lean();

    if (!category) {
      return NextResponse.json(
        { success: false, error: 'Category not found' },
        { status: 404 },
      );
    }

    const currentProductIds: string[] = [];
    if (category.products && Array.isArray(category.products)) {
      for (const p of category.products) {
        if (p && typeof p === 'object' && '_id' in p) {
          currentProductIds.push(String(p._id));
        }
      }
    }

    await Product.updateMany(
      { categoryId: id, _id: { $nin: currentProductIds } },
      { categoryId: null, categoryName: null },
    );

    if (currentProductIds.length > 0) {
      await Product.updateMany(
        { _id: { $in: currentProductIds } },
        { categoryId: category._id, categoryName: category.name },
      );
    }

    await logActivity({
      userId: auth.user.userId,
      userName: auth.user.name,
      userEmail: auth.user.email,
      action: 'update',
      resource: 'category',
      resourceId: id,
      details: `Updated category: ${category.name}`,
    });

    return NextResponse.json({ success: true, data: category });
  } catch (error) {
    console.error('Error updating category:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to update category' },
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
    const auth = await requireAdminPageAccess('categories');
    if ('error' in auth) return auth.error;

    const { id } = await params;

    await Product.updateMany(
      { categoryId: id },
      { categoryId: null, categoryName: null },
    );

    const category = await Category.findByIdAndDelete(id).lean();

    if (!category) {
      return NextResponse.json(
        { success: false, error: 'Category not found' },
        { status: 404 },
      );
    }

    await logActivity({
      userId: auth.user.userId,
      userName: auth.user.name,
      userEmail: auth.user.email,
      action: 'delete',
      resource: 'category',
      resourceId: id,
      details: `Deleted category: ${category.name}`,
    });

    return NextResponse.json({ success: true, message: 'Category deleted successfully' });
  } catch (error) {
    console.error('Error deleting category:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to delete category' },
      { status: 500 },
    );
  }
}
