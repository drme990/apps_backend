import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAuth } from '@/lib/auth';
import ErrorLog from '@/lib/models/ErrorLog';

/**
 * DELETE /api/error-logs/[id]
 * Superadmin-only: delete a single error log.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await connectDB();

    const auth = await requireAuth();
    if ('error' in auth) return auth.error;

    if (auth.user.role !== 'super_admin') {
      return NextResponse.json(
        { success: false, error: 'Super admin access required' },
        { status: 403 },
      );
    }

    const { id } = await params;
    const result = await ErrorLog.findByIdAndDelete(id);

    if (!result) {
      return NextResponse.json(
        { success: false, error: 'Error log not found' },
        { status: 404 },
      );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error deleting error log:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to delete error log' },
      { status: 500 },
    );
  }
}
