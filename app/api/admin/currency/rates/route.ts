import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAuth } from '@/lib/auth';
import { getExchangeRates } from '@/lib/services/currency';

export async function GET(request: NextRequest) {
  try {
    await connectDB();
    const auth = await requireAuth();
    if ('error' in auth) return auth.error;

    const { searchParams } = new URL(request.url);
    const base = searchParams.get('base') || 'SAR';

    const rates = await getExchangeRates(base.toLowerCase());
    return NextResponse.json({ success: true, data: rates });
  } catch (error) {
    console.error('Error fetching exchange rates:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch exchange rates' },
      { status: 500 },
    );
  }
}
