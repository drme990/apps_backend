import { v2 as cloudinary } from 'cloudinary';

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

export interface CloudinaryUploadResult {
  success: boolean;
  url?: string;
  publicId?: string;
  error?: string;
}

export async function uploadImage(
  file: string,
  folder: string = 'products',
  publicId?: string,
): Promise<CloudinaryUploadResult> {
  try {
    if (
      !process.env.CLOUDINARY_CLOUD_NAME ||
      !process.env.CLOUDINARY_API_KEY ||
      !process.env.CLOUDINARY_API_SECRET
    ) {
      return { success: false, error: 'Cloudinary configuration is missing' };
    }

    const uploadOptions: Record<string, unknown> = {
      folder,
      resource_type: 'image',
      transformation: [
        { width: 1000, height: 1000, crop: 'limit' },
        { quality: 'auto' },
        { fetch_format: 'auto' },
      ],
    };

    if (publicId) uploadOptions.public_id = publicId;

    const result = await cloudinary.uploader.upload(file, uploadOptions);
    return {
      success: true,
      url: result.secure_url,
      publicId: result.public_id,
    };
  } catch (error) {
    console.error('Error uploading to Cloudinary:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to upload image',
    };
  }
}

export async function deleteImage(
  publicId: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    if (!publicId) return { success: false, error: 'Public ID is required' };
    await cloudinary.uploader.destroy(publicId);
    return { success: true };
  } catch (error) {
    console.error('Error deleting from Cloudinary:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to delete image',
    };
  }
}

export function extractPublicId(url: string): string | null {
  try {
    const match = url.match(/\/upload\/(?:v\d+\/)?(.+)\.\w+$/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

export function isCloudinaryUrl(url: string): boolean {
  return url.includes('res.cloudinary.com');
}

export default cloudinary;
