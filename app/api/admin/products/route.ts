import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAuth } from '@/lib/auth';
import Product from '@/lib/models/Product';
import { logActivity } from '@/lib/services/logger';

export async function GET() {
  try {
    await connectDB();
    const auth = await requireAuth();
    if ('error' in auth) return auth.error;

    const products = await Product.find()
      .sort({ displayOrder: 1, createdAt: -1 })
      .lean();
    return NextResponse.json({ success: true, data: { products } });
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
    const auth = await requireAuth();
    if ('error' in auth) return auth.error;

    const body = await request.json();
    const product = await Product.create(body);

    await logActivity({
      userId: auth.user.userId,
      userName: auth.user.name,
      userEmail: auth.user.email,
      action: 'create',
      resource: 'product',
      resourceId: product._id.toString(),
      details: `Created product: ${product.name.en || product.name.ar}`,
    });

    return NextResponse.json({ success: true, data: product }, { status: 201 });
  } catch (error) {
    console.error('Error creating product:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to create product' },
      { status: 500 },
    );
  }
}
