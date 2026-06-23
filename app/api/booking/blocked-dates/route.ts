import { NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import Booking from '@/lib/models/Booking';
import {
  refreshDefaultExecutionDateCache,
  parseCutoffTime,
  getDefaultCutoffTime,
  autoResetDayEndIfStale,
} from '@/lib/execution-date';

export async function GET() {
  try {
    await connectDB();
    await autoResetDayEndIfStale();
    const defaultExecutionDate = await refreshDefaultExecutionDateCache();
    const booking = await Booking.findOne({ key: 'global' }).lean();

    const normalizedCutoff = booking?.cutoffTime
      ? parseCutoffTime(booking.cutoffTime)
      : null;

    return NextResponse.json({
      success: true,
      data: {
        blockedExecutionDates: booking?.blockedExecutionDates ?? [],
        defaultExecutionDate,
        cutoffTime: normalizedCutoff ?? getDefaultCutoffTime(),
        lastDayEndAt: booking?.lastDayEndAt ?? null,
      },
    });
  } catch {
    return NextResponse.json({
      success: true,
      data: {
        blockedExecutionDates: [],
        defaultExecutionDate: null,
        cutoffTime: null,
        lastDayEndAt: null,
      },
    });
  }
}
