# Cloudinary Image Upload Integration

This document explains how the Cloudinary image upload integration works in the Manasik Foundation platform.

## Overview

The admin panel now supports direct image uploads to Cloudinary for product images. This eliminates the need to manually host images and provides automatic optimization, transformation, and CDN delivery.

## Features

- **Drag & Drop Upload**: Modern file upload interface in the admin panel
- **Image Preview**: Preview images before uploading
- **Automatic Optimization**: Images are automatically optimized (WebP, compression, etc.)
- **Size Limits**: Max 1000x1000px dimensions, 5MB file size limit
- **Format Support**: JPEG, PNG, WebP, and GIF
- **Old Image Cleanup**: Automatically deletes old images when updating
- **Activity Logging**: All uploads are logged in the activity log
- **Secure**: Protected API routes requiring authentication

## Setup

### 1. Get Cloudinary Credentials

1. Sign up for a free account at [cloudinary.com](https://cloudinary.com)
2. Go to your Dashboard
3. Copy your credentials:
   - Cloud Name
   - API Key
   - API Secret

### 2. Configure Environment Variables

Add these to your `.env.local` file:

```env
# Cloudinary Configuration
CLOUDINARY_CLOUD_NAME=your-cloud-name
CLOUDINARY_API_KEY=your-api-key
CLOUDINARY_API_SECRET=your-api-secret
```

### 3. Update Next.js Configuration

The `next.config.ts` file is already configured to allow images from Cloudinary:

```typescript
images: {
  remotePatterns: [
    {
      protocol: 'https',
      hostname: 'res.cloudinary.com',
      pathname: '/**',
    }
  ],
}
```

## Usage

### For Admins

1. Navigate to the Admin Products page (`/admin/products`)
2. Click "Add Product" or edit an existing product
3. In the Product Form:
   - Click "Choose Image" to select an image file
   - Preview the image before uploading
   - Fill in other product details
   - Click "Add Product" or "Update Product"
4. The image is automatically uploaded to Cloudinary and the URL is saved

### For Developers

#### Upload an Image

```typescript
// In a Server Component or API Route
import { uploadImage } from '@/lib/cloudinary';

const result = await uploadImage(
  base64ImageString,
  'products', // folder name
  'optional-public-id' // optional custom ID
);

if (result.success) {
  console.log('Image URL:', result.url);
  console.log('Public ID:', result.publicId);
}
```

#### Delete an Image

```typescript
import { deleteImage, extractPublicId } from '@/lib/cloudinary';

const publicId = extractPublicId(imageUrl);
if (publicId) {
  await deleteImage(publicId);
}
```

#### Check if URL is from Cloudinary

```typescript
import { isCloudinaryUrl } from '@/lib/cloudinary';

if (isCloudinaryUrl(url)) {
  // Handle Cloudinary image
}
```

## API Endpoints

### POST `/api/upload/image`

Upload an image to Cloudinary. Requires authentication.

**Request:**

- Method: `POST`
- Content-Type: `multipart/form-data`
- Body:
  - `file`: Image file (required)
  - `folder`: Folder name in Cloudinary (optional, default: 'products')
  - `oldImageUrl`: Previous image URL to delete (optional)

**Response:**

```json
{
  "success": true,
  "data": {
    "url": "https://res.cloudinary.com/...",
    "publicId": "products/abc123"
  }
}
```

### DELETE `/api/upload/image`

Delete an image from Cloudinary. Requires authentication.

**Request:**

- Method: `DELETE`
- Query Parameters:
  - `url`: Cloudinary image URL to delete (required)

**Response:**

```json
{
  "success": true,
  "message": "Image deleted successfully"
}
```

## File Structure

```
lib/
  cloudinary.ts           # Cloudinary utilities and configuration
app/
  api/
    upload/
      image/
        route.ts          # Image upload API endpoints
  admin/
    products/
      page.tsx           # Admin product management with upload UI
```

## Image Transformations

All uploaded images are automatically transformed:

- **Max Dimensions**: 1000x1000px (maintains aspect ratio)
- **Quality**: Auto (Cloudinary optimizes based on content)
- **Format**: Auto (serves WebP to supported browsers)

You can customize these in `lib/cloudinary.ts`:

```typescript
transformation: [
  { width: 1000, height: 1000, crop: 'limit' },
  { quality: 'auto' },
  { fetch_format: 'auto' },
]
```

## Security

- **Authentication Required**: All upload/delete endpoints require valid JWT token
- **File Type Validation**: Only allowed image formats (JPEG, PNG, WebP, GIF)
- **File Size Limit**: 5MB maximum
- **Activity Logging**: All uploads are logged with user information

## Troubleshooting

### "Failed to upload image"

1. Check that all Cloudinary environment variables are set correctly
2. Verify your Cloudinary credentials are valid
3. Check the console for detailed error messages

### "Cloudinary configuration is missing"

- Ensure all three environment variables are set:
  - `CLOUDINARY_CLOUD_NAME`
  - `CLOUDINARY_API_KEY`
  - `CLOUDINARY_API_SECRET`

### Images not displaying

1. Verify the image URL in the database is valid
2. Check that `next.config.ts` includes Cloudinary in `remotePatterns`
3. Restart the development server after config changes

### Upload is slow

- Check your internet connection
- Large images (> 2MB) may take longer to upload
- Consider compressing images before upload

## Best Practices

1. **Image Preparation**: Compress images before upload when possible
2. **Alt Text**: Always provide descriptive alt text for accessibility
3. **Cleanup**: The system automatically deletes old images when updating
4. **Folder Organization**: Use consistent folder names for better organization
5. **Monitoring**: Check Cloudinary dashboard for usage and quotas

## Cloudinary Free Tier Limits

- **Storage**: 25 GB
- **Bandwidth**: 25 GB/month
- **Transformations**: 25,000/month

Monitor your usage in the Cloudinary dashboard. For production, consider upgrading to a paid plan.

## Additional Resources

- [Cloudinary Documentation](https://cloudinary.com/documentation)
- [Cloudinary Node.js SDK](https://cloudinary.com/documentation/node_integration)
- [Next.js Image Optimization](https://nextjs.org/docs/app/building-your-application/optimizing/images)
