import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import {
  uploadFileToR2,
  deleteFileFromR2,
  isR2Url,
  extractR2Key,
} from '@/lib/services/r2';
import { captureException } from '@/lib/services/error-monitor';
import { validateInput } from '@/lib/validation/http';
import {
  uploadImageDeleteSchema,
  uploadImageFormSchema,
} from '@/lib/validation/schemas';

const ALLOWED_TYPES = [
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/gif',
];
const MAX_SIZE = 5 * 1024 * 1024; // 5MB

function resolveImageFolder(folder?: string): string {
  const normalizedFolder = folder?.trim();

  switch (normalizedFolder) {
    case 'products':
      return 'products/images';
    case 'customers':
      return 'Website Images/customers';
    case 'website':
    case 'appearance':
    default:
      return 'Website Images/website';
  }
}

export async function POST(request: NextRequest) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess('appearance');
    if ('error' in auth) return auth.error;

    const formData = await request.formData();
    const parsed = validateInput(
      {
        file: formData.get('file'),
        oldUrl:
          typeof formData.get('oldUrl') === 'string'
            ? (formData.get('oldUrl') as string)
            : undefined,
        folder:
          typeof formData.get('folder') === 'string'
            ? (formData.get('folder') as string)
            : undefined,
      },
      uploadImageFormSchema,
    );
    if (!parsed.success) return parsed.response;

    const { file, oldUrl, folder } = parsed.data;

    if (!ALLOWED_TYPES.includes(file.type)) {
      return NextResponse.json(
        {
          success: false,
          error:
            'Invalid file type. Only JPEG, PNG, WebP, and GIF are allowed.',
        },
        { status: 400 },
      );
    }

    if (file.size > MAX_SIZE) {
      return NextResponse.json(
        { success: false, error: 'File size exceeds 5MB limit' },
        { status: 400 },
      );
    }

    const imageFolder = resolveImageFolder(folder);
    const result = await uploadFileToR2(file, imageFolder);

    // Optionally delete the old image after the new upload succeeds.
    if (oldUrl && isR2Url(oldUrl)) {
      const key = extractR2Key(oldUrl);
      if (key && key !== result.key) {
        await deleteFileFromR2(key);
      }
    }

    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    captureException(error, {
      service: 'R2ImageRoute',
      operation: 'POST_Upload',
      severity: 'medium',
    });
    return NextResponse.json(
      { success: false, error: 'Failed to upload image' },
      { status: 500 },
    );
  }
}

export async function DELETE(request: NextRequest) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess('appearance');
    if ('error' in auth) return auth.error;

    const parsed = validateInput(
      { url: request.nextUrl.searchParams.get('url') },
      uploadImageDeleteSchema,
    );
    if (!parsed.success) return parsed.response;

    const { url } = parsed.data;

    if (!isR2Url(url)) {
      return NextResponse.json(
        { success: false, error: 'Not a valid image URL' },
        { status: 400 },
      );
    }

    const key = extractR2Key(url);
    if (!key) {
      return NextResponse.json(
        { success: false, error: 'Could not extract object key from URL' },
        { status: 400 },
      );
    }

    await deleteFileFromR2(key);

    return NextResponse.json({
      success: true,
      message: 'Image deleted successfully',
    });
  } catch (error) {
    captureException(error, {
      service: 'R2ImageRoute',
      operation: 'DELETE_Image',
      severity: 'medium',
    });
    return NextResponse.json(
      { success: false, error: 'Failed to delete image' },
      { status: 500 },
    );
  }
}
