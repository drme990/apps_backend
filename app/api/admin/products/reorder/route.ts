import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAuth } from '@/lib/auth';
import Product from '@/lib/models/Product';
import { logActivity } from '@/lib/services/logger';

export async function PUT(request: NextRequest) {
  try {
    await connectDB();
    const auth = await requireAuth();
    if ('error' in auth) return auth.error;

    const { orderedIds } = await request.json();

    if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
      return NextResponse.json(
        { success: false, error: 'orderedIds array is required' },
        { status: 400 },
      );
    }

    const bulkOps = orderedIds.map((id: string, index: number) => ({
      updateOne: {
        filter: { _id: id },
        update: { $set: { displayOrder: index } },
      },
    }));

    await Product.bulkWrite(bulkOps);

    await logActivity({
      userId: auth.user.userId,
      userName: auth.user.name,
      userEmail: auth.user.email,
      action: 'update',
      resource: 'product',
      details: `Reordered ${orderedIds.length} products`,
    });

    return NextResponse.json({
      success: true,
      message: 'Products reordered successfully',
    });
  } catch (error) {
    console.error('Error reordering products:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to reorder products' },
      { status: 500 },
    );
  }
}
