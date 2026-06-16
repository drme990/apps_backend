import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import Category from '@/lib/models/Categories';
import { logActivity } from '@/lib/services/logger';
import { parseJsonBody } from '@/lib/validation/http';
import { categoryCreateSchema } from '@/lib/validation/schemas';

export async function GET() {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess('categories');
    if ('error' in auth) return auth.error;

    const categories = await Category.find()
      .populate('products', '_id name slug')
      .sort({ categoryNumber: 1 })
      .lean();

    return NextResponse.json({ success: true, data: { categories } });
  } catch (error) {
    console.error('Error fetching categories:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch categories' },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess('categories');
    if ('error' in auth) return auth.error;

    const parsed = await parseJsonBody(request, categoryCreateSchema);
    if (!parsed.success) return parsed.response;
    const body = parsed.data;

    const existing = await Category.findOne({ categoryNumber: body.categoryNumber });
    if (existing) {
      return NextResponse.json(
        { success: false, error: 'Category number already exists' },
        { status: 409 },
      );
    }

    const category = await Category.create(body);

    await logActivity({
      userId: auth.user.userId,
      userName: auth.user.name,
      userEmail: auth.user.email,
      action: 'create',
      resource: 'category',
      resourceId: category._id.toString(),
      details: `Created category: ${category.name}`,
    });

    return NextResponse.json(
      { success: true, data: category.toObject() },
      { status: 201 },
    );
  } catch (error) {
    console.error('Error creating category:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to create category' },
      { status: 500 },
    );
  }
}
