import { Router, Request, Response } from 'express';
import Country from '../../models/Country';
import { requireAuth } from '../../middleware/auth';
import { logActivity } from '../../services/logger';

const router = Router();

router.use(requireAuth);

// GET /api/admin/countries
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

// POST /api/admin/countries
router.post('/', async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const existing = await Country.findOne({
      code: req.body.code?.toUpperCase(),
    });
    if (existing) {
      res
        .status(400)
        .json({ success: false, error: 'Country code already exists' });
      return;
    }

    const country = await Country.create(req.body);

    await logActivity({
      userId: user.userId,
      userName: user.name,
      userEmail: user.email,
      action: 'create',
      resource: 'country',
      resourceId: country._id.toString(),
      details: `Created country: ${country.name.en} (${country.code})`,
    });

    res.status(201).json({ success: true, data: country });
  } catch (error) {
    console.error('Error creating country:', error);
    res.status(500).json({ success: false, error: 'Failed to create country' });
  }
});

// PUT /api/admin/countries/reorder
router.put('/reorder', async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { orderedIds } = req.body;

    if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
      res
        .status(400)
        .json({ success: false, error: 'orderedIds array is required' });
      return;
    }

    const bulkOps = orderedIds.map((id: string, index: number) => ({
      updateOne: {
        filter: { _id: id },
        update: { $set: { sortOrder: index } },
      },
    }));

    await Country.bulkWrite(bulkOps);

    await logActivity({
      userId: user.userId,
      userName: user.name,
      userEmail: user.email,
      action: 'update',
      resource: 'country',
      details: `Reordered ${orderedIds.length} countries`,
    });

    res.json({ success: true, message: 'Countries reordered successfully' });
  } catch (error) {
    console.error('Error reordering countries:', error);
    res
      .status(500)
      .json({ success: false, error: 'Failed to reorder countries' });
  }
});

// GET /api/admin/countries/:id
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

// PUT /api/admin/countries/:id
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const country = await Country.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
      runValidators: true,
    });
    if (!country) {
      res.status(404).json({ success: false, error: 'Country not found' });
      return;
    }

    await logActivity({
      userId: user.userId,
      userName: user.name,
      userEmail: user.email,
      action: 'update',
      resource: 'country',
      resourceId: country._id.toString(),
      details: `Updated country: ${country.name.en} (${country.code})`,
    });

    res.json({ success: true, data: country });
  } catch (error) {
    console.error('Error updating country:', error);
    res.status(500).json({ success: false, error: 'Failed to update country' });
  }
});

// DELETE /api/admin/countries/:id
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const country = await Country.findByIdAndDelete(req.params.id);
    if (!country) {
      res.status(404).json({ success: false, error: 'Country not found' });
      return;
    }

    await logActivity({
      userId: user.userId,
      userName: user.name,
      userEmail: user.email,
      action: 'delete',
      resource: 'country',
      resourceId: req.params.id as string,
      details: `Deleted country: ${country.name.en} (${country.code})`,
    });

    res.json({ success: true, message: 'Country deleted successfully' });
  } catch (error) {
    console.error('Error deleting country:', error);
    res.status(500).json({ success: false, error: 'Failed to delete country' });
  }
});

export default router;
