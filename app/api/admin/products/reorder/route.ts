import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAuth } from '@/lib/auth';
import Product from '@/lib/models/Product';
import { logActivity } from '@/lib/services/logger';
import { parseJsonBody } from '@/lib/validation/http';
import { reorderSchema } from '@/lib/validation/schemas';

export async function PUT(request: NextRequest) {
  try {
    await connectDB();
    const auth = await requireAuth();
    if ('error' in auth) return auth.error;

    const parsed = await parseJsonBody(request, reorderSchema);
    if (!parsed.success) return parsed.response;
    const { orderedIds } = parsed.data;

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
