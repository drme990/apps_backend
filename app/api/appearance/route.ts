import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import Appearance from '@/lib/models/Appearance';

export async function GET(request: NextRequest) {
  const EMPTY = {
    worksImages: { row1: [] as string[], row2: [] as string[] },
    whatsAppDefaultMessage: '',
  };
  try {
    await connectDB();
    const project = request.nextUrl.searchParams.get('project') || 'manasik';
    const appearance = (await Appearance.findOne({ project }).lean()) as {
      worksImages?: { row1: string[]; row2: string[] };
      whatsAppDefaultMessage?: string;
    } | null;

    if (!appearance) {
      return NextResponse.json({
        success: true,
        data: {
          ...EMPTY,
          row1: EMPTY.worksImages.row1,
          row2: EMPTY.worksImages.row2,
        },
      });
    }

    const worksImages = {
      row1: appearance.worksImages?.row1 ?? [],
      row2: appearance.worksImages?.row2 ?? [],
    };

    return NextResponse.json({
      success: true,
      data: {
        worksImages,
        whatsAppDefaultMessage: appearance.whatsAppDefaultMessage?.trim() || '',
        // Keep backward compatibility for existing consumers.
        row1: worksImages.row1,
        row2: worksImages.row2,
      },
    });
  } catch {
    return NextResponse.json({
      success: true,
      data: {
        ...EMPTY,
        row1: EMPTY.worksImages.row1,
        row2: EMPTY.worksImages.row2,
      },
    });
  }
}
