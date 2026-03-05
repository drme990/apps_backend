import { Router, Request, Response } from 'express';
import { getExchangeRates, convertCurrency } from '../../services/currency';

const router = Router();

// GET /api/currency/rates?base=SAR
// GET /api/currency/rates?base=SAR&target=USD&amount=100
router.get('/rates', async (req: Request, res: Response) => {
  try {
    const base = (req.query.base as string) || 'SAR';
    const target = req.query.target as string | undefined;
    const amount = req.query.amount as string | undefined;

    if (target && amount) {
      const converted = await convertCurrency(parseFloat(amount), base, target);
      res.json({
        success: true,
        data: {
          from: base.toUpperCase(),
          to: target.toUpperCase(),
          amount: parseFloat(amount),
          converted,
        },
      });
      return;
    }

    const rates = await getExchangeRates(base);
    res.json({ success: true, data: { base: base.toUpperCase(), rates } });
  } catch (error) {
    console.error('Error fetching exchange rates:', error);
    res
      .status(500)
      .json({ success: false, error: 'Failed to fetch exchange rates' });
  }
});

export default router;
