import { Router, Request, Response } from 'express';
import Product from '../../models/Product';
import { requireAuth } from '../../middleware/auth';
import { logActivity } from '../../services/logger';
import { convertToMultipleCurrencies } from '../../services/currency';

const router = Router();

router.use(requireAuth);

// GET /api/admin/products
router.get('/', async (req: Request, res: Response) => {
  try {
    const products = await Product.find()
      .sort({ displayOrder: 1, createdAt: -1 })
      .lean();
    res.json({ success: true, data: { products } });
  } catch (error) {
    console.error('Error fetching products:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch products' });
  }
});

// POST /api/admin/products
router.post('/', async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const product = await Product.create(req.body);

    await logActivity({
      userId: user.userId,
      userName: user.name,
      userEmail: user.email,
      action: 'create',
      resource: 'product',
      resourceId: product._id.toString(),
      details: `Created product: ${product.name.en || product.name.ar}`,
    });

    res.status(201).json({ success: true, data: product });
  } catch (error) {
    console.error('Error creating product:', error);
    res.status(500).json({ success: false, error: 'Failed to create product' });
  }
});

// GET /api/admin/products/:id
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

// PUT /api/admin/products/:id
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const product = await Product.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
      runValidators: true,
    });
    if (!product) {
      res.status(404).json({ success: false, error: 'Product not found' });
      return;
    }

    await logActivity({
      userId: user.userId,
      userName: user.name,
      userEmail: user.email,
      action: 'update',
      resource: 'product',
      resourceId: product._id.toString(),
      details: `Updated product: ${product.name.en || product.name.ar}`,
    });

    res.json({ success: true, data: product });
  } catch (error) {
    console.error('Error updating product:', error);
    res.status(500).json({ success: false, error: 'Failed to update product' });
  }
});

// DELETE /api/admin/products/:id
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const product = await Product.findByIdAndDelete(req.params.id);
    if (!product) {
      res.status(404).json({ success: false, error: 'Product not found' });
      return;
    }

    await logActivity({
      userId: user.userId,
      userName: user.name,
      userEmail: user.email,
      action: 'delete',
      resource: 'product',
      resourceId: req.params.id as string,
      details: `Deleted product: ${product.name.en || product.name.ar}`,
    });

    res.json({ success: true, message: 'Product deleted successfully' });
  } catch (error) {
    console.error('Error deleting product:', error);
    res.status(500).json({ success: false, error: 'Failed to delete product' });
  }
});

// PUT /api/admin/products/reorder
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
        update: { $set: { displayOrder: index } },
      },
    }));

    await Product.bulkWrite(bulkOps);

    await logActivity({
      userId: user.userId,
      userName: user.name,
      userEmail: user.email,
      action: 'update',
      resource: 'product',
      details: `Reordered ${orderedIds.length} products`,
    });

    res.json({ success: true, message: 'Products reordered successfully' });
  } catch (error) {
    console.error('Error reordering products:', error);
    res
      .status(500)
      .json({ success: false, error: 'Failed to reorder products' });
  }
});

// POST /api/admin/products/:id/auto-price
router.post('/:id/auto-price', async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { targetCurrencies } = req.body;

    if (!Array.isArray(targetCurrencies) || targetCurrencies.length === 0) {
      res
        .status(400)
        .json({ success: false, error: 'targetCurrencies array is required' });
      return;
    }

    const product = await Product.findById(req.params.id);
    if (!product) {
      res.status(404).json({ success: false, error: 'Product not found' });
      return;
    }

    for (const size of product.sizes) {
      const converted = await convertToMultipleCurrencies(
        size.price,
        product.baseCurrency,
        targetCurrencies,
      );

      for (const [code, amount] of Object.entries(converted)) {
        const existingIndex = size.prices.findIndex(
          (p: { currencyCode: string; isManual: boolean }) =>
            p.currencyCode === code,
        );

        if (existingIndex >= 0) {
          if (!size.prices[existingIndex].isManual) {
            size.prices[existingIndex].amount = amount;
          }
        } else {
          size.prices.push({ currencyCode: code, amount, isManual: false });
        }
      }
    }

    // Also update partial payment minimums
    if (product.partialPayment?.minimumPayments) {
      const baseCurrency = product.baseCurrency;
      const baseMinimum = product.partialPayment.minimumPayments.find(
        (mp: { currencyCode: string }) => mp.currencyCode === baseCurrency,
      );

      if (baseMinimum) {
        const converted = await convertToMultipleCurrencies(
          baseMinimum.value,
          baseCurrency,
          targetCurrencies,
        );

        for (const [code, amount] of Object.entries(converted)) {
          const existingIndex =
            product.partialPayment.minimumPayments.findIndex(
              (mp: { currencyCode: string; isManual: boolean }) =>
                mp.currencyCode === code,
            );

          if (existingIndex >= 0) {
            if (
              !product.partialPayment.minimumPayments[existingIndex].isManual
            ) {
              product.partialPayment.minimumPayments[existingIndex].value =
                Math.ceil(amount);
            }
          } else {
            product.partialPayment.minimumPayments.push({
              currencyCode: code,
              value: Math.ceil(amount),
              isManual: false,
            });
          }
        }
      }
    }

    await product.save();

    await logActivity({
      userId: user.userId,
      userName: user.name,
      userEmail: user.email,
      action: 'update',
      resource: 'product',
      resourceId: product._id.toString(),
      details: `Auto-priced product "${product.name.en || product.name.ar}" for ${targetCurrencies.join(', ')}`,
    });

    res.json({ success: true, data: product });
  } catch (error) {
    console.error('Error auto-pricing product:', error);
    res
      .status(500)
      .json({ success: false, error: 'Failed to auto-price product' });
  }
});

export default router;
