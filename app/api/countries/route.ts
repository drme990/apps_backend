import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import Country from '@/lib/models/Country';

export async function GET(request: NextRequest) {
  try {
    await connectDB();

    const active = request.nextUrl.searchParams.get('active');
    const activeOnly = active !== 'false';
    const query = activeOnly ? { isActive: true } : {};

    const countries = await Country.find(query)
      .sort({ sortOrder: 1, 'name.ar': 1 })
      .lean();

    return NextResponse.json({ success: true, data: countries });
  } catch (error) {
    console.error('Error fetching countries:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch countries' },
      { status: 500 },
    );
  }
}
