import { NextRequest, NextResponse } from 'next/server';
import { getLiveLogs } from '@/lib/services/live-logs';
import { clearLiveLogs } from '@/lib/services/live-logs';
import { connectDB } from '@/lib/db';
import TerminalLog from '@/lib/models/TerminalLog';

const LOGS_PASSWORD = process.env.BACKEND_LOGS_PASSWORD || '20202020';

function isLogsEndpointNoise(entry: {
  message?: string;
  payload?: Record<string, unknown>;
}): boolean {
  const message = (entry.message || '').toLowerCase();
  const payloadPath =
    typeof entry.payload?.path === 'string' ? entry.payload.path : '';

  return message.includes('/api/logs') || payloadPath.startsWith('/api/logs');
}

function isAuthorized(request: NextRequest): boolean {
  const headerPassword = request.headers.get('x-logs-password');
  const queryPassword = request.nextUrl.searchParams.get('password');
  const providedPassword = headerPassword || queryPassword || '';
  return providedPassword === LOGS_PASSWORD;
}

export async function GET(request: NextRequest) {
  try {
    if (!isAuthorized(request)) {
      return NextResponse.json(
        { success: false, error: 'Unauthorized' },
        { status: 401 },
      );
    }

    await connectDB();

    const limit = Math.min(
      100,
      Math.max(20, Number(request.nextUrl.searchParams.get('limit') || '50')),
    );

    const dbLogs = await TerminalLog.find({})
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    const merged = [
      ...getLiveLogs(limit).map((entry) => ({
        ...entry,
        kind: 'live' as const,
      })),
      ...dbLogs.map((entry) => ({
        ts: entry.ts,
        level: entry.level,
        event: entry.event,
        source: entry.source,
        message: entry.message,
        payload: entry.payload,
        kind: 'live' as const,
      })),
    ];

    const deduped = merged.filter(
      (entry, index, array) =>
        index ===
        array.findIndex(
          (candidate) =>
            candidate.ts === entry.ts &&
            candidate.level === entry.level &&
            candidate.event === entry.event &&
            candidate.message === entry.message,
        ),
    );

    const visibleLogs = deduped.filter((entry) => !isLogsEndpointNoise(entry));

    return NextResponse.json({
      success: true,
      data: {
        logs: visibleLogs.slice(0, limit),
      },
    });
  } catch (error) {
    console.error('Error fetching live logs:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch logs' },
      { status: 500 },
    );
  }
}

export async function DELETE(request: NextRequest) {
  try {
    if (!isAuthorized(request)) {
      return NextResponse.json(
        { success: false, error: 'Unauthorized' },
        { status: 401 },
      );
    }

    await connectDB();
    const result = await TerminalLog.deleteMany({});
    clearLiveLogs();

    return NextResponse.json({
      success: true,
      data: {
        deletedCount: result.deletedCount,
      },
    });
  } catch (error) {
    console.error('Error deleting live logs:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to delete logs' },
      { status: 500 },
    );
  }
}
