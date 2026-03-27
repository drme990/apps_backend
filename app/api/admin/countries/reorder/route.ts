import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import Country from '@/lib/models/Country';
import { logActivity } from '@/lib/services/logger';
import { parseJsonBody } from '@/lib/validation/http';
import { reorderSchema } from '@/lib/validation/schemas';

export async function PUT(request: NextRequest) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess('countries');
    if ('error' in auth) return auth.error;

    const parsed = await parseJsonBody(request, reorderSchema);
    if (!parsed.success) return parsed.response;
    const { orderedIds } = parsed.data;

    const bulkOps = orderedIds.map((id: string, index: number) => ({
      updateOne: {
        filter: { _id: id },
        update: { $set: { sortOrder: index } },
      },
    }));

    await Country.bulkWrite(bulkOps);

    await logActivity({
      userId: auth.user.userId,
      userName: auth.user.name,
      userEmail: auth.user.email,
      action: 'update',
      resource: 'country',
      details: `Reordered ${orderedIds.length} countries`,
    });

    return NextResponse.json({
      success: true,
      message: 'Countries reordered successfully',
    });
  } catch (error) {
    console.error('Error reordering countries:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to reorder countries' },
      { status: 500 },
    );
  }
}
