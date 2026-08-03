import { NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { getDefaultPhones } from '@/lib/models/Setting';

/**
 * Public endpoint — returns the default WhatsApp phone numbers for the
 * manasik and ghadaq apps. No auth required (phone numbers are not sensitive).
 *
 * Used by the client apps as the fallback WhatsApp number when a referral
 * doesn't have a phone number associated with it.
 */
export async function GET() {
  try {
    await connectDB();
    const phones = await getDefaultPhones();
    return NextResponse.json({ success: true, data: phones });
  } catch (error) {
    console.error('Error fetching default phones:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch default phones' },
      { status: 500 },
    );
  }
}
