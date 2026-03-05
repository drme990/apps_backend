import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import Appearance from '@/lib/models/Appearance';

export async function GET(request: NextRequest) {
  const EMPTY = { row1: [] as string[], row2: [] as string[] };
  try {
    await connectDB();
    const project = request.nextUrl.searchParams.get('project') || 'manasik';
    const appearance = (await Appearance.findOne({ project }).lean()) as {
      worksImages?: { row1: string[]; row2: string[] };
    } | null;

    if (!appearance) {
      return NextResponse.json({ success: true, data: EMPTY });
    }

    return NextResponse.json({
      success: true,
      data: {
        row1: appearance.worksImages?.row1 ?? [],
        row2: appearance.worksImages?.row2 ?? [],
      },
    });
  } catch {
    return NextResponse.json({ success: true, data: EMPTY });
  }
}
