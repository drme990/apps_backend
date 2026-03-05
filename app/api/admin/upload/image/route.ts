import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAuth } from '@/lib/auth';
import {
  uploadImage,
  deleteImage,
  isCloudinaryUrl,
  extractPublicId,
} from '@/lib/services/cloudinary';
import { logActivity } from '@/lib/services/logger';

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
    const auth = await requireAuth();
    if ('error' in auth) return auth.error;

    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    const oldUrl = formData.get('oldUrl') as string | null;

    if (!file) {
      return NextResponse.json(
        { success: false, error: 'No file uploaded' },
        { status: 400 },
      );
    }

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
    console.error('Error uploading image:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to upload image' },
      { status: 500 },
    );
  }
}

export async function DELETE(request: NextRequest) {
  try {
    await connectDB();
    const auth = await requireAuth();
    if ('error' in auth) return auth.error;

    const url = request.nextUrl.searchParams.get('url');

    if (!url) {
      return NextResponse.json(
        { success: false, error: 'URL is required' },
        { status: 400 },
      );
    }

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
    console.error('Error deleting image:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to delete image' },
      { status: 500 },
    );
  }
}
