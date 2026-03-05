import { NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAuth } from '@/lib/auth';
import CronLog from '@/lib/models/CronLog';

export async function GET() {
  try {
    await connectDB();
    const auth = await requireAuth();
    if ('error' in auth) return auth.error;

    const logs = await CronLog.find({ jobName: 'update-prices' })
      .sort({ createdAt: -1 })
      .limit(20)
      .lean();

    return NextResponse.json({ success: true, data: logs });
  } catch (error) {
    console.error('Error fetching exchange logs:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch exchange logs' },
      { status: 500 },
    );
  }
}
