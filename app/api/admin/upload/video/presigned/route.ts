import { NextRequest, NextResponse } from 'next/server';
import { requireAdminPageAccess } from '@/lib/auth';
import { generatePresignedUploadUrl } from '@/lib/services/r2';
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
const MIN_UPLOAD_URL_EXPIRES_SEC = 300;
const MAX_UPLOAD_URL_EXPIRES_SEC = 3600;
const ESTIMATED_MIN_UPLOAD_SPEED_BYTES_PER_SEC = 100 * 1024;

const presignedVideoSchema = z.object({
  fileName: z.string().min(1, 'File name is required'),
  contentType: z.string().min(1, 'Content type is required'),
  fileSize: z.number().positive('File size must be positive'),
});

/**
 * GET /api/admin/upload/video/presigned
 * Generate a presigned URL for direct client-side upload to R2
 *
 * Query Parameters:
 *   - fileName: Name of the video file
 *   - contentType: MIME type of the video
 *   - fileSize: Size of the file in bytes
 *
 * Response:
 * {
 *   "success": true,
 *   "data": {
 *     "uploadUrl": "https://...",  // Direct upload URL to R2
 *     "key": "products/videos/...",  // R2 object key
 *     "publicUrl": "https://..."  // Final CDN URL after upload
 *   }
 * }
 */
export async function GET(request: NextRequest) {
  try {
    const auth = await requireAdminPageAccess('products');
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
      presignedVideoSchema,
    );
    if (!parsed.success) return parsed.response;

    const { fileName: fn, contentType: ct, fileSize: fs } = parsed.data;

    // Validate content type
    if (!ALLOWED_TYPES.includes(ct)) {
      return NextResponse.json(
        {
          success: false,
          error: `Invalid content type. Allowed: ${ALLOWED_TYPES.join(', ')}`,
        },
        { status: 400 },
      );
    }

    // Validate file size
    if (fs > MAX_SIZE) {
      return NextResponse.json(
        { success: false, error: 'File too large (max 50MB)' },
        { status: 400 },
      );
    }

    const estimatedUploadSeconds = Math.ceil(
      fs / ESTIMATED_MIN_UPLOAD_SPEED_BYTES_PER_SEC,
    );
    const expiresIn = Math.max(
      MIN_UPLOAD_URL_EXPIRES_SEC,
      Math.min(MAX_UPLOAD_URL_EXPIRES_SEC, estimatedUploadSeconds + 180),
    );

    const result = await generatePresignedUploadUrl(
      fn,
      ct,
      'products/videos',
      expiresIn,
    );

    return NextResponse.json({
      success: true,
      data: result,
    });
  } catch (error) {
    console.error('Presigned URL generation error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to generate upload URL' },
      { status: 500 },
    );
  }
}
