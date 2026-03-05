import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAuth } from '@/lib/auth';
import ActivityLog from '@/lib/models/ActivityLog';

export async function GET(request: NextRequest) {
  try {
    await connectDB();
    const auth = await requireAuth();
    if ('error' in auth) return auth.error;

    const page = parseInt(request.nextUrl.searchParams.get('page') || '1');
    const limit = parseInt(request.nextUrl.searchParams.get('limit') || '50');
    const skip = (page - 1) * limit;

    const logs = await ActivityLog.find()
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
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
