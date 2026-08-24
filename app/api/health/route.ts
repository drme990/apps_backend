import { NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';

/**
 * GET /api/health
 *
 * Lightweight health check for Docker/uptime monitoring.
 * Checks:
 *   - Server is responding
 *   - MongoDB connection is alive
 *
 * Returns 200 if healthy, 503 if any dependency is down.
 */
export async function GET() {
  const checks: Record<string, 'ok' | 'fail'> = {
    server: 'ok',
  };

  // ── MongoDB ──────────────────────────────────────────────────────
  try {
    await connectDB();
    checks.db = 'ok';
  } catch {
    checks.db = 'fail';
  }

  const healthy = Object.values(checks).every((v) => v === 'ok');

  return NextResponse.json(
    {
      status: healthy ? 'healthy' : 'unhealthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      checks,
    },
    { status: healthy ? 200 : 503 },
  );
}
