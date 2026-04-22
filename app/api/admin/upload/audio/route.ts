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
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/x-wav',
  'audio/ogg',
  'audio/webm',
  'audio/mp4',
  'audio/aac',
  'audio/x-m4a',
];

const MAX_SIZE = 20 * 1024 * 1024; // 20MB

const uploadAudioFormSchema = z.object({
  file: z.instanceof(File),
});

const extensionTypeMap: Record<string, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  webm: 'audio/webm',
  mp4: 'audio/mp4',
  m4a: 'audio/x-m4a',
  aac: 'audio/aac',
};

function normalizeAudioContentType(file: File): string | null {
  const normalizedType = file.type.toLowerCase();
  if (ALLOWED_TYPES.includes(normalizedType)) {
    return normalizedType;
  }

  if (normalizedType === '' || normalizedType === 'application/octet-stream') {
    const ext = file.name.split('.').pop()?.toLowerCase() || '';
    return extensionTypeMap[ext] || null;
  }

  return null;
}

// Keep fallback server uploads available for clients that cannot use direct presigned uploads.
export const maxDuration = 300;

export async function POST(request: NextRequest) {
  try {
    const auth = await requireAdminPageAccess('appearance');
    if ('error' in auth) return auth.error;

    const formData = await request.formData();
    const file = formData.get('file');

    const parsed = validateInput(
      {
        file,
      },
      uploadAudioFormSchema,
    );
    if (!parsed.success) return parsed.response;

    const uploadedFile = parsed.data.file;
    const resolvedType = normalizeAudioContentType(uploadedFile);

    if (!resolvedType) {
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
        { success: false, error: 'File too large (max 20MB)' },
        { status: 400 },
      );
    }

    const uploadFile =
      uploadedFile.type === resolvedType
        ? uploadedFile
        : new File([uploadedFile], uploadedFile.name, {
            type: resolvedType,
            lastModified: Date.now(),
          });

    const result = await uploadVideoToR2(uploadFile, 'audio');

    return NextResponse.json({
      success: true,
      data: { url: result.url },
    });
  } catch (error) {
    console.error('Audio upload error:', error);

    const isTimeoutError =
      typeof error === 'object' &&
      error !== null &&
      'name' in error &&
      String((error as { name?: string }).name).includes('TimeoutError');

    return NextResponse.json(
      {
        success: false,
        error: isTimeoutError
          ? 'Upload timed out while transferring audio to storage. Please retry.'
          : 'Failed to upload audio',
      },
      { status: isTimeoutError ? 504 : 500 },
    );
  }
}

const deleteAudioSchema = z.object({
  url: z.string().url(),
});

export async function DELETE(request: NextRequest) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess('appearance');
    if ('error' in auth) return auth.error;

    const body = await request.json();
    const parsed = validateInput(body, deleteAudioSchema);
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
    console.error('Audio delete error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to delete audio' },
      { status: 500 },
    );
  }
}
