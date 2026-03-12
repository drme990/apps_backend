import { NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import Booking from '@/lib/models/Booking';

export async function GET() {
  try {
    await connectDB();
    const booking = await Booking.findOne({ key: 'global' }).lean();

    return NextResponse.json({
      success: true,
      data: {
        blockedExecutionDates: booking?.blockedExecutionDates ?? [],
      },
    });
  } catch {
    return NextResponse.json({
      success: true,
      data: {
        blockedExecutionDates: [],
      },
    });
  }
}
