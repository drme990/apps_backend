import { Router, Request, Response } from 'express';
import Appearance from '../../models/Appearance';
import { requireAuth } from '../../middleware/auth';
import { logActivity } from '../../services/logger';

const router = Router();

const VALID_PROJECTS = ['ghadaq', 'manasik'];

// GET /api/admin/appearance/:project — public within admin context
router.get('/:project', async (req: Request, res: Response) => {
  try {
    const { project } = req.params;
    if (!VALID_PROJECTS.includes(project as string)) {
      res
        .status(400)
        .json({
          success: false,
          error:
            'Invalid project. Must be one of: ' + VALID_PROJECTS.join(', '),
        });
      return;
    }

    const appearance = await Appearance.findOne({ project }).lean();
    res.json({ success: true, data: appearance });
  } catch (error) {
    console.error('Error fetching appearance:', error);
    res
      .status(500)
      .json({ success: false, error: 'Failed to fetch appearance' });
  }
});

// PUT /api/admin/appearance/:project — requires auth
router.put('/:project', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { project } = req.params;

    if (!VALID_PROJECTS.includes(project as string)) {
      res
        .status(400)
        .json({
          success: false,
          error:
            'Invalid project. Must be one of: ' + VALID_PROJECTS.join(', '),
        });
      return;
    }

    const appearance = await Appearance.findOneAndUpdate(
      { project },
      { ...req.body, project },
      { new: true, upsert: true, runValidators: true },
    );

    await logActivity({
      userId: user.userId,
      userName: user.name,
      userEmail: user.email,
      action: 'update',
      resource: 'appearance',
      resourceId: appearance._id.toString(),
      details: `Updated appearance for project: ${project}`,
    });

    res.json({ success: true, data: appearance });
  } catch (error) {
    console.error('Error updating appearance:', error);
    res
      .status(500)
      .json({ success: false, error: 'Failed to update appearance' });
  }
});

export default router;
