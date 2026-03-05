import { Router, Request, Response } from 'express';
import Product from '../../models/Product';
import User from '../../models/User';
import Order from '../../models/Order';
import Country from '../../models/Country';
import { requireAuth } from '../../middleware/auth';

const router = Router();

router.use(requireAuth);

// GET /api/admin/stats
router.get('/', async (req: Request, res: Response) => {
  try {
    const [totalProducts, totalUsers, totalOrders, totalCountries] =
      await Promise.all([
        Product.countDocuments(),
        User.countDocuments(),
        Order.countDocuments(),
        Country.countDocuments(),
      ]);

    res.json({
      success: true,
      data: { totalProducts, totalUsers, totalOrders, totalCountries },
    });
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch stats' });
  }
});

export default router;
