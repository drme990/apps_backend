import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import RefTrackerEvent from '@/lib/models/RefTrackerEvent';
import { parseJsonBody } from '@/lib/validation/http';
import { refTrackerEventSchema } from '@/lib/validation/schemas';
import { getClientIp, isValidIp } from '@/lib/utils/ip';

export async function POST(request: NextRequest) {
  try {
    await connectDB();

    const parsed = await parseJsonBody(request, refTrackerEventSchema);
    if (!parsed.success) return parsed.response;

    const body = parsed.data;
    const ip = getClientIp(request);

    const event = await RefTrackerEvent.create({
      ...body,
      userId: body.userId?.trim() || undefined,
      ref: body.ref?.trim() || undefined,
      productName: body.productName?.trim() || undefined,
      buttonLabel: body.buttonLabel?.trim() || undefined,
      choice: body.choice?.trim() || undefined,
      ip: isValidIp(ip) ? ip : ip || undefined,
    });

    return NextResponse.json({ success: true, data: event }, { status: 201 });
  } catch (error) {
    console.error('Error recording ref tracker event:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to record tracker event' },
      { status: 500 },
    );
  }
}