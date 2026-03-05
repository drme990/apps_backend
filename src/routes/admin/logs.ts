import { Router, Request, Response } from 'express';
import ActivityLog from '../../models/ActivityLog';
import { requireAuth } from '../../middleware/auth';

const router = Router();

router.use(requireAuth);

// GET /api/admin/logs
router.get('/', async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 50;
    const skip = (page - 1) * limit;

    const [logs, total] = await Promise.all([
      ActivityLog.find().sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      ActivityLog.countDocuments(),
    ]);

    res.json({
      success: true,
      data: { logs },
    });
  } catch (error) {
    console.error('Error fetching logs:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch logs' });
  }
});

export default router;
