import { Router, Request, Response } from 'express';
import Appearance from '../../models/Appearance';

const router = Router();

// GET /api/appearance?project=manasik  (defaults to manasik)
router.get('/', async (req: Request, res: Response) => {
  const EMPTY = { row1: [] as string[], row2: [] as string[] };
  try {
    const project = (req.query.project as string) || 'manasik';
    const appearance = (await Appearance.findOne({ project }).lean()) as {
      worksImages?: { row1: string[]; row2: string[] };
    } | null;

    if (!appearance) {
      res.json({ success: true, data: EMPTY });
      return;
    }

    res.json({
      success: true,
      data: {
        row1: appearance.worksImages?.row1 ?? [],
        row2: appearance.worksImages?.row2 ?? [],
      },
    });
  } catch {
    res.json({ success: true, data: { row1: [], row2: [] } });
  }
});

export default router;
