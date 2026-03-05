import { Router, Request, Response } from 'express';
import Product, { IProduct } from '../../models/Product';

const router = Router();

// GET /api/products — List products with pagination
router.get('/', async (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 10;
    const page = parseInt(req.query.page as string) || 1;
    const inStock = req.query.inStock as string | undefined;
    const sacrifice = req.query.sacrifice as string | undefined;

    const query: Partial<Pick<IProduct, 'inStock' | 'workAsSacrifice'>> = {};
    if (inStock !== undefined) query.inStock = inStock === 'true';
    if (sacrifice === 'true') query.workAsSacrifice = true;

    const skip = (page - 1) * limit;

    const products = await Product.find(query)
      .sort({ displayOrder: 1, createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    const total = await Product.countDocuments(query);
    const totalPages = Math.ceil(total / limit);

    res.json({
      success: true,
      data: {
        products,
        pagination: {
          currentPage: page,
          totalPages,
          totalProducts: total,
          hasNextPage: page < totalPages,
          hasPrevPage: page > 1,
        },
      },
    });
  } catch (error) {
    console.error('Error fetching products:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch products' });
  }
});

// GET /api/products/:id — Single product
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const product = await Product.findById(req.params.id).lean();

    if (!product) {
      res.status(404).json({ success: false, error: 'Product not found' });
      return;
    }

    res.json({ success: true, data: product });
  } catch (error) {
    console.error('Error fetching product:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch product' });
  }
});

export default router;
