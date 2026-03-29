import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import ActivityLog from '@/lib/models/ActivityLog';

export async function GET(request: NextRequest) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess('activityLogs');
    if ('error' in auth) return auth.error;

    const page = parseInt(request.nextUrl.searchParams.get('page') || '1');
    const limit = parseInt(request.nextUrl.searchParams.get('limit') || '50');
    const maxLimit = limit > 200 ? 200 : limit;
    const skip = (page - 1) * maxLimit;

    const logs = await ActivityLog.find({
      $or: [
        { resource: { $ne: 'auth' } },
        {
          details: {
            $not: /Logged in to (ghadaq|manasik) successfully/i,
          },
        },
      ],
    })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(maxLimit)
      .lean();

    return NextResponse.json({ success: true, data: { logs } });
  } catch (error) {
    console.error('Error fetching logs:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch logs' },
      { status: 500 },
    );
  }
}
