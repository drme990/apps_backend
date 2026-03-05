import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import Country from '@/lib/models/Country';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await connectDB();
    const { id } = await params;
    const country = await Country.findById(id).lean();

    if (!country) {
      return NextResponse.json(
        { success: false, error: 'Country not found' },
        { status: 404 },
      );
    }

    return NextResponse.json({ success: true, data: country });
  } catch (error) {
    console.error('Error fetching country:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch country' },
      { status: 500 },
    );
  }
}
