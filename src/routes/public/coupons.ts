import { Router, Request, Response } from 'express';
import { validateCoupon } from '../../services/coupon';

const router = Router();

// POST /api/coupons/validate
router.post('/validate', async (req: Request, res: Response) => {
  try {
    const { code, orderAmount, currency, productId } = req.body;

    if (!code || !orderAmount || !currency) {
      res
        .status(400)
        .json({
          success: false,
          error: 'Missing required fields: code, orderAmount, currency',
        });
      return;
    }

    const result = await validateCoupon(code, orderAmount, currency, productId);

    if (!result.valid) {
      res.status(400).json({ success: false, error: result.error });
      return;
    }

    res.json({
      success: true,
      data: {
        code: result.coupon?.code,
        type: result.coupon?.type,
        value: result.coupon?.value,
        discountAmount: result.discountAmount,
        description: result.coupon?.description,
      },
    });
  } catch (error) {
    console.error('Error validating coupon:', error);
    res
      .status(500)
      .json({ success: false, error: 'Failed to validate coupon' });
  }
});

export default router;
