import { Router, Request, Response } from 'express';
import multer from 'multer';
import {
  uploadImage,
  deleteImage,
  isCloudinaryUrl,
  extractPublicId,
} from '../../services/cloudinary';
import { requireAuth } from '../../middleware/auth';
import { logActivity } from '../../services/logger';

const router = Router();

router.use(requireAuth);

const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (_req, file, cb) => {
    const allowedTypes = [
      'image/jpeg',
      'image/jpg',
      'image/png',
      'image/webp',
      'image/gif',
    ];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(
        new Error(
          'Invalid file type. Only JPEG, PNG, WebP, and GIF are allowed.',
        ),
      );
    }
  },
});

// POST /api/admin/upload
router.post('/', upload.single('file'), async (req: Request, res: Response) => {
  try {
    const user = req.user!;

    if (!req.file) {
      res.status(400).json({ success: false, error: 'No file uploaded' });
      return;
    }

    const base64 = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
    const result = await uploadImage(base64);

    // Optionally delete old image
    const oldUrl = req.body.oldUrl;
    if (oldUrl && isCloudinaryUrl(oldUrl)) {
      const publicId = extractPublicId(oldUrl);
      if (publicId) {
        await deleteImage(publicId);
      }
    }

    await logActivity({
      userId: user.userId,
      userName: user.name,
      userEmail: user.email,
      action: 'create',
      resource: 'upload',
      resourceId: result.publicId || '',
      details: `Uploaded image: ${req.file.originalname}`,
    });

    res.json({ success: true, data: result });
  } catch (error: any) {
    console.error('Error uploading image:', error);
    if (error.message?.includes('Invalid file type')) {
      res.status(400).json({ success: false, error: error.message });
      return;
    }
    res.status(500).json({ success: false, error: 'Failed to upload image' });
  }
});

// DELETE /api/admin/upload
router.delete('/', async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const url = req.query.url as string;

    if (!url) {
      res.status(400).json({ success: false, error: 'URL is required' });
      return;
    }

    if (!isCloudinaryUrl(url)) {
      res
        .status(400)
        .json({ success: false, error: 'Not a valid Cloudinary URL' });
      return;
    }

    const publicId = extractPublicId(url);
    if (!publicId) {
      res
        .status(400)
        .json({
          success: false,
          error: 'Could not extract public ID from URL',
        });
      return;
    }

    await deleteImage(publicId);

    await logActivity({
      userId: user.userId,
      userName: user.name,
      userEmail: user.email,
      action: 'delete',
      resource: 'upload',
      resourceId: publicId,
      details: `Deleted image: ${publicId}`,
    });

    res.json({ success: true, message: 'Image deleted successfully' });
  } catch (error) {
    console.error('Error deleting image:', error);
    res.status(500).json({ success: false, error: 'Failed to delete image' });
  }
});

export default router;
