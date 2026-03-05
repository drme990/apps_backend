import { Router, Request, Response } from 'express';
import Coupon from '../../models/Coupon';
import { requireAuth } from '../../middleware/auth';
import { logActivity } from '../../services/logger';
import { validateCoupon } from '../../services/coupon';

const router = Router();

router.use(requireAuth);

// GET /api/admin/coupons
router.get('/', async (req: Request, res: Response) => {
  try {
    const coupons = await Coupon.find().sort({ createdAt: -1 }).lean();
    res.json({ success: true, data: { coupons } });
  } catch (error) {
    console.error('Error fetching coupons:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch coupons' });
  }
});

// POST /api/admin/coupons
router.post('/', async (req: Request, res: Response) => {
  try {
    const user = req.user!;

    const existing = await Coupon.findOne({
      code: req.body.code?.toUpperCase().trim(),
    });
    if (existing) {
      res
        .status(400)
        .json({ success: false, error: 'Coupon code already exists' });
      return;
    }

    const coupon = await Coupon.create({ ...req.body, createdBy: user.userId });

    await logActivity({
      userId: user.userId,
      userName: user.name,
      userEmail: user.email,
      action: 'create',
      resource: 'coupon',
      resourceId: coupon._id.toString(),
      details: `Created coupon: ${coupon.code} (${coupon.type}: ${coupon.value})`,
    });

    res.status(201).json({ success: true, data: coupon });
  } catch (error) {
    console.error('Error creating coupon:', error);
    res.status(500).json({ success: false, error: 'Failed to create coupon' });
  }
});

// POST /api/admin/coupons/validate
router.post('/validate', async (req: Request, res: Response) => {
  try {
    const { code, orderAmount, currency, productId } = req.body;

    if (!code || !orderAmount || !currency) {
      res
        .status(400)
        .json({ success: false, error: 'Missing required fields' });
      return;
    }

    const result = await validateCoupon(code, orderAmount, currency, productId);

    if (!result.valid) {
      res.status(400).json({ success: false, error: result.error });
      return;
    }

    res.json({ success: true, data: result });
  } catch (error) {
    console.error('Error validating coupon:', error);
    res
      .status(500)
      .json({ success: false, error: 'Failed to validate coupon' });
  }
});

// GET /api/admin/coupons/:id
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const coupon = await Coupon.findById(req.params.id).lean();
    if (!coupon) {
      res.status(404).json({ success: false, error: 'Coupon not found' });
      return;
    }
    res.json({ success: true, data: coupon });
  } catch (error) {
    console.error('Error fetching coupon:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch coupon' });
  }
});

// PUT /api/admin/coupons/:id
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const coupon = await Coupon.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
      runValidators: true,
    });
    if (!coupon) {
      res.status(404).json({ success: false, error: 'Coupon not found' });
      return;
    }

    await logActivity({
      userId: user.userId,
      userName: user.name,
      userEmail: user.email,
      action: 'update',
      resource: 'coupon',
      resourceId: coupon._id.toString(),
      details: `Updated coupon: ${coupon.code}`,
    });

    res.json({ success: true, data: coupon });
  } catch (error) {
    console.error('Error updating coupon:', error);
    res.status(500).json({ success: false, error: 'Failed to update coupon' });
  }
});

// DELETE /api/admin/coupons/:id
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const coupon = await Coupon.findByIdAndDelete(req.params.id);
    if (!coupon) {
      res.status(404).json({ success: false, error: 'Coupon not found' });
      return;
    }

    await logActivity({
      userId: user.userId,
      userName: user.name,
      userEmail: user.email,
      action: 'delete',
      resource: 'coupon',
      resourceId: req.params.id as string,
      details: `Deleted coupon: ${coupon.code}`,
    });

    res.json({ success: true, message: 'Coupon deleted successfully' });
  } catch (error) {
    console.error('Error deleting coupon:', error);
    res.status(500).json({ success: false, error: 'Failed to delete coupon' });
  }
});

export default router;
