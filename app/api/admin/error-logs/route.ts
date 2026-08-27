import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAuth } from '@/lib/auth';
import ErrorLog from '@/lib/models/ErrorLog';

/**
 * GET /api/error-logs
 * Superadmin-only: list error logs with pagination + filters.
 */
export async function GET(request: NextRequest) {
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

    const { searchParams } = request.nextUrl;
    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10));
    const limit = Math.min(
      100,
      Math.max(1, parseInt(searchParams.get('limit') || '50', 10)),
    );
    const level = searchParams.get('level'); // error | warn | fatal
    const source = searchParams.get('source');
    const url = searchParams.get('url');
    const search = searchParams.get('search');

    const query: Record<string, unknown> = {};
    if (level && ['error', 'warn', 'fatal'].includes(level)) {
      query.level = level;
    }
    if (source) query.source = source;
    if (url) query.url = { $regex: url, $options: 'i' };
    if (search) {
      query.$or = [
        { message: { $regex: search, $options: 'i' } },
        { stack: { $regex: search, $options: 'i' } },
        { source: { $regex: search, $options: 'i' } },
      ];
    }

    const skip = (page - 1) * limit;
    const [logs, total] = await Promise.all([
      ErrorLog.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      ErrorLog.countDocuments(query),
    ]);

    return NextResponse.json({
      success: true,
      data: logs,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error('Error fetching error logs:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch error logs' },
      { status: 500 },
    );
  }
}

/**
 * DELETE /api/error-logs
 * Superadmin-only: delete all error logs (or by filter).
 */
export async function DELETE(request: NextRequest) {
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

    const { searchParams } = request.nextUrl;
    const level = searchParams.get('level');

    const filter: Record<string, unknown> = {};
    if (level && ['error', 'warn', 'fatal'].includes(level)) {
      filter.level = level;
    }

    const result = await ErrorLog.deleteMany(filter);

    return NextResponse.json({
      success: true,
      deletedCount: result.deletedCount,
    });
  } catch (error) {
    console.error('Error deleting error logs:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to delete error logs' },
      { status: 500 },
    );
  }
}
