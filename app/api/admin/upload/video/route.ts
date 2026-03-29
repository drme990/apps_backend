import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import {
  uploadVideoToR2,
  deleteVideoFromR2,
  isR2Url,
  extractR2Key,
} from '@/lib/services/r2';
import { validateInput } from '@/lib/validation/http';
import { z } from 'zod';

const ALLOWED_TYPES = [
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'video/x-msvideo',
  'video/mpeg',
  'video/ogg',
];
const MAX_SIZE = 50 * 1024 * 1024; // 50MB

const uploadVideoFormSchema = z.object({
  file: z.instanceof(File),
  oldUrl: z.string().optional(),
});

export const maxDuration = 120;

export async function POST(request: NextRequest) {
  try {
    const auth = await requireAdminPageAccess('products');
    if ('error' in auth) return auth.error;

    const formData = await request.formData();
    const file = formData.get('file');
    const oldUrl = formData.get('oldUrl');

    const parsed = validateInput(
      {
        file: file,
        oldUrl: typeof oldUrl === 'string' ? oldUrl : undefined,
      },
      uploadVideoFormSchema,
    );
    if (!parsed.success) return parsed.response;

    const uploadedFile = parsed.data.file;

    if (!ALLOWED_TYPES.includes(uploadedFile.type)) {
      return NextResponse.json(
        {
          success: false,
          error: `Invalid file type. Allowed: ${ALLOWED_TYPES.join(', ')}`,
        },
        { status: 400 },
      );
    }

    if (uploadedFile.size > MAX_SIZE) {
      return NextResponse.json(
        { success: false, error: 'File too large (max 50MB)' },
        { status: 400 },
      );
    }

    if (parsed.data.oldUrl && isR2Url(parsed.data.oldUrl)) {
      const key = extractR2Key(parsed.data.oldUrl);
      if (key) await deleteVideoFromR2(key);
    }

    const result = await uploadVideoToR2(uploadedFile);

    return NextResponse.json({
      success: true,
      data: { url: result.url },
    });
  } catch (error) {
    console.error('Video upload error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to upload video' },
      { status: 500 },
    );
  }
}

const deleteVideoSchema = z.object({
  url: z.string().url(),
});

export async function DELETE(request: NextRequest) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess('products');
    if ('error' in auth) return auth.error;

    const body = await request.json();
    const parsed = validateInput(body, deleteVideoSchema);
    if (!parsed.success) return parsed.response;

    const { url } = parsed.data;

    if (isR2Url(url)) {
      const key = extractR2Key(url);
      if (key) {
        await deleteVideoFromR2(key);
        return NextResponse.json({ success: true });
      }
    }

    return NextResponse.json(
      { success: false, error: 'Invalid URL or not hosted on R2' },
      { status: 400 },
    );
  } catch (error) {
    console.error('Video delete error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to delete video' },
      { status: 500 },
    );
  }
}
