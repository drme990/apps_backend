import { Router, Request, Response } from 'express';
import { getExchangeRates } from '../../services/currency';
import { requireAuth } from '../../middleware/auth';

const router = Router();

router.use(requireAuth);

// GET /api/admin/currency/rates
router.get('/rates', async (req: Request, res: Response) => {
  try {
    const base = (req.query.base as string) || 'SAR';
    const rates = await getExchangeRates(base);
    res.json({ success: true, data: rates });
  } catch (error) {
    console.error('Error fetching exchange rates:', error);
    res
      .status(500)
      .json({ success: false, error: 'Failed to fetch exchange rates' });
  }
});

export default router;
