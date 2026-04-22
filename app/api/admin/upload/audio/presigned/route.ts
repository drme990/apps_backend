import { NextRequest, NextResponse } from 'next/server';
import { requireAdminPageAccess } from '@/lib/auth';
import { generatePresignedUploadUrl } from '@/lib/services/r2';
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

const extensionTypeMap: Record<string, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  webm: 'audio/webm',
  mp4: 'audio/mp4',
  m4a: 'audio/x-m4a',
  aac: 'audio/aac',
};

const MAX_SIZE = 20 * 1024 * 1024; // 20MB
const MIN_UPLOAD_URL_EXPIRES_SEC = 300;
const MAX_UPLOAD_URL_EXPIRES_SEC = 3600;
const ESTIMATED_MIN_UPLOAD_SPEED_BYTES_PER_SEC = 80 * 1024;

const presignedAudioSchema = z.object({
  fileName: z.string().min(1, 'File name is required'),
  contentType: z.string().min(1, 'Content type is required'),
  fileSize: z.number().positive('File size must be positive'),
});

function normalizeAudioContentType(
  contentType: string,
  fileName: string,
): string | null {
  const normalizedType = contentType.toLowerCase();
  if (ALLOWED_TYPES.includes(normalizedType)) {
    return normalizedType;
  }

  if (normalizedType === '' || normalizedType === 'application/octet-stream') {
    const ext = fileName.split('.').pop()?.toLowerCase() || '';
    return extensionTypeMap[ext] || null;
  }

  return null;
}

export async function GET(request: NextRequest) {
  try {
    const auth = await requireAdminPageAccess('appearance');
    if ('error' in auth) return auth.error;

    const searchParams = request.nextUrl.searchParams;
    const fileNameParam = searchParams.get('fileName');
    const contentTypeParam = searchParams.get('contentType');
    const fileSizeParam = searchParams.get('fileSize');

    const parsed = validateInput(
      {
        fileName: fileNameParam,
        contentType: contentTypeParam,
        fileSize: fileSizeParam ? parseInt(fileSizeParam) : undefined,
      },
      presignedAudioSchema,
    );
    if (!parsed.success) return parsed.response;

    const { fileName, contentType, fileSize } = parsed.data;
    const resolvedType = normalizeAudioContentType(contentType, fileName);

    if (!resolvedType) {
      return NextResponse.json(
        {
          success: false,
          error: `Invalid content type. Allowed: ${ALLOWED_TYPES.join(', ')}`,
        },
        { status: 400 },
      );
    }

    if (fileSize > MAX_SIZE) {
      return NextResponse.json(
        { success: false, error: 'File too large (max 20MB)' },
        { status: 400 },
      );
    }

    const estimatedUploadSeconds = Math.ceil(
      fileSize / ESTIMATED_MIN_UPLOAD_SPEED_BYTES_PER_SEC,
    );
    const expiresIn = Math.max(
      MIN_UPLOAD_URL_EXPIRES_SEC,
      Math.min(MAX_UPLOAD_URL_EXPIRES_SEC, estimatedUploadSeconds + 180),
    );

    const result = await generatePresignedUploadUrl(
      fileName,
      resolvedType,
      'audio',
      expiresIn,
    );

    return NextResponse.json({
      success: true,
      data: result,
    });
  } catch (error) {
    console.error('Audio presigned URL generation error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to generate upload URL' },
      { status: 500 },
    );
  }
}
