import { Router, Request, Response } from 'express';
import Country from '../../models/Country';

const router = Router();

// GET /api/countries — List countries
router.get('/', async (req: Request, res: Response) => {
  try {
    const activeOnly = req.query.active !== 'false';
    const query = activeOnly ? { isActive: true } : {};
    const countries = await Country.find(query)
      .sort({ sortOrder: 1, 'name.ar': 1 })
      .lean();

    res.json({ success: true, data: countries });
  } catch (error) {
    console.error('Error fetching countries:', error);
    res
      .status(500)
      .json({ success: false, error: 'Failed to fetch countries' });
  }
});

// GET /api/countries/:id — Single country
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const country = await Country.findById(req.params.id).lean();

    if (!country) {
      res.status(404).json({ success: false, error: 'Country not found' });
      return;
    }

    res.json({ success: true, data: country });
  } catch (error) {
    console.error('Error fetching country:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch country' });
  }
});

export default router;
