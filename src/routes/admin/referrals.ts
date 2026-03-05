import { Router, Request, Response } from 'express';
import Referral from '../../models/Referral';
import { requireAuth } from '../../middleware/auth';
import { logActivity } from '../../services/logger';

const router = Router();

router.use(requireAuth);

// GET /api/admin/referrals
router.get('/', async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 100;
    const skip = (page - 1) * limit;

    const [referrals, total] = await Promise.all([
      Referral.find().sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Referral.countDocuments(),
    ]);

    const totalPages = Math.ceil(total / limit);
    res.json({
      success: true,
      data: { referrals, pagination: { totalPages } },
    });
  } catch (error) {
    console.error('Error fetching referrals:', error);
    res
      .status(500)
      .json({ success: false, error: 'Failed to fetch referrals' });
  }
});

// POST /api/admin/referrals
router.post('/', async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { name, referralId, phone } = req.body;

    const existing = await Referral.findOne({ referralId });
    if (existing) {
      res
        .status(400)
        .json({ success: false, error: 'Referral ID already exists' });
      return;
    }

    const referral = await Referral.create({ name, referralId, phone });

    await logActivity({
      userId: user.userId,
      userName: user.name,
      userEmail: user.email,
      action: 'create',
      resource: 'referral',
      resourceId: referral._id.toString(),
      details: `Created referral: ${referral.name} (${referral.referralId})`,
    });

    res.status(201).json({ success: true, data: referral });
  } catch (error) {
    console.error('Error creating referral:', error);
    res
      .status(500)
      .json({ success: false, error: 'Failed to create referral' });
  }
});

// GET /api/admin/referrals/:id
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const referral = await Referral.findById(req.params.id).lean();
    if (!referral) {
      res.status(404).json({ success: false, error: 'Referral not found' });
      return;
    }
    res.json({ success: true, data: referral });
  } catch (error) {
    console.error('Error fetching referral:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch referral' });
  }
});

// PUT /api/admin/referrals/:id
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const referral = await Referral.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
      runValidators: true,
    });
    if (!referral) {
      res.status(404).json({ success: false, error: 'Referral not found' });
      return;
    }

    await logActivity({
      userId: user.userId,
      userName: user.name,
      userEmail: user.email,
      action: 'update',
      resource: 'referral',
      resourceId: referral._id.toString(),
      details: `Updated referral: ${referral.name} (${referral.referralId})`,
    });

    res.json({ success: true, data: referral });
  } catch (error) {
    console.error('Error updating referral:', error);
    res
      .status(500)
      .json({ success: false, error: 'Failed to update referral' });
  }
});

// DELETE /api/admin/referrals/:id
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const referral = await Referral.findByIdAndDelete(req.params.id);
    if (!referral) {
      res.status(404).json({ success: false, error: 'Referral not found' });
      return;
    }

    await logActivity({
      userId: user.userId,
      userName: user.name,
      userEmail: user.email,
      action: 'delete',
      resource: 'referral',
      resourceId: req.params.id as string,
      details: `Deleted referral: ${referral.name} (${referral.referralId})`,
    });

    res.json({ success: true, message: 'Referral deleted successfully' });
  } catch (error) {
    console.error('Error deleting referral:', error);
    res
      .status(500)
      .json({ success: false, error: 'Failed to delete referral' });
  }
});

export default router;
