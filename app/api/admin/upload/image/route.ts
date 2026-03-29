import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import {
  uploadImage,
  deleteImage,
  isCloudinaryUrl,
  extractPublicId,
} from '@/lib/services/cloudinary';
import { logActivity } from '@/lib/services/logger';
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
      },
      uploadImageFormSchema,
    );
    if (!parsed.success) return parsed.response;

    const { file, oldUrl } = parsed.data;

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

    const arrayBuffer = await file.arrayBuffer();
    const base64 = `data:${file.type};base64,${Buffer.from(arrayBuffer).toString('base64')}`;
    const result = await uploadImage(base64);

    // Optionally delete old image
    if (oldUrl && isCloudinaryUrl(oldUrl)) {
      const publicId = extractPublicId(oldUrl);
      if (publicId) {
        await deleteImage(publicId);
      }
    }

    await logActivity({
      userId: auth.user.userId,
      userName: auth.user.name,
      userEmail: auth.user.email,
      action: 'create',
      resource: 'upload',
      resourceId: result.publicId || '',
      details: `Uploaded image: ${file.name}`,
    });

    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    captureException(error, {
      service: 'CloudinaryRoute',
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

    if (!isCloudinaryUrl(url)) {
      return NextResponse.json(
        { success: false, error: 'Not a valid Cloudinary URL' },
        { status: 400 },
      );
    }

    const publicId = extractPublicId(url);
    if (!publicId) {
      return NextResponse.json(
        { success: false, error: 'Could not extract public ID from URL' },
        { status: 400 },
      );
    }

    await deleteImage(publicId);

    await logActivity({
      userId: auth.user.userId,
      userName: auth.user.name,
      userEmail: auth.user.email,
      action: 'delete',
      resource: 'upload',
      resourceId: publicId,
      details: `Deleted image: ${publicId}`,
    });

    return NextResponse.json({
      success: true,
      message: 'Image deleted successfully',
    });
  } catch (error) {
    captureException(error, {
      service: 'CloudinaryRoute',
      operation: 'DELETE_Image',
      severity: 'medium',
    });
    return NextResponse.json(
      { success: false, error: 'Failed to delete image' },
      { status: 500 },
    );
  }
}
