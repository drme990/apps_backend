import { NextRequest, NextResponse } from 'next/server';
import { generatePresignedDownloadUrl } from '@/lib/services/r2';

// POST /api/storage/download - Generate presigned download URL
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { key } = body;
    
    if (!key) {
      return NextResponse.json(
        { success: false, error: 'Key is required' },
        { status: 400 }
      );
    }
    
    const downloadUrl = await generatePresignedDownloadUrl(key);
    
    return NextResponse.json({ success: true, downloadUrl });
  } catch (error) {
    console.error('Error generating download URL:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to generate download URL' },
      { status: 500 }
    );
  }
}
