import { Router, Request, Response } from 'express';
import Order from '../../models/Order';
import { requireAuth } from '../../middleware/auth';
import { logActivity } from '../../services/logger';
import { sendOrderConfirmationEmail } from '../../services/email';

const router = Router();

router.use(requireAuth);

// GET /api/admin/orders
router.get('/', async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const status = req.query.status as string | undefined;
    const search = req.query.search as string | undefined;
    const source = req.query.source as string | undefined;
    const skip = (page - 1) * limit;

    const query: Record<string, unknown> = {};
    if (status && status !== 'all') query.status = status;
    if (source && source !== 'all') query.source = source;

    if (search) {
      query.$or = [
        { orderNumber: { $regex: search, $options: 'i' } },
        { 'billingData.fullName': { $regex: search, $options: 'i' } },
        { 'billingData.email': { $regex: search, $options: 'i' } },
        { 'billingData.phone': { $regex: search, $options: 'i' } },
      ];
    }

    const [orders, total] = await Promise.all([
      Order.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Order.countDocuments(query),
    ]);

    const totalPages = Math.ceil(total / limit);

    res.json({
      success: true,
      data: {
        orders,
        pagination: {
          currentPage: page,
          totalPages,
          totalOrders: total,
          hasNextPage: page < totalPages,
          hasPrevPage: page > 1,
        },
      },
    });
  } catch (error) {
    console.error('Error fetching orders:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch orders' });
  }
});

// GET /api/admin/orders/:id
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const order = await Order.findById(req.params.id).lean();
    if (!order) {
      res.status(404).json({ success: false, error: 'Order not found' });
      return;
    }
    res.json({ success: true, data: order });
  } catch (error) {
    console.error('Error fetching order:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch order' });
  }
});

// PUT /api/admin/orders/:id
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { status, notes } = req.body;

    const order = await Order.findById(req.params.id);
    if (!order) {
      res.status(404).json({ success: false, error: 'Order not found' });
      return;
    }

    const changes: string[] = [];
    if (status && status !== order.status) {
      order.status = status;
      changes.push(`status → ${status}`);
    }
    if (notes !== undefined && notes !== order.notes) {
      order.notes = notes;
      changes.push('notes updated');
    }

    if (changes.length === 0) {
      res.json({ success: true, data: order });
      return;
    }

    await order.save();

    // Send confirmation email if status changed to paid
    if (status === 'paid' && changes.includes('status → paid')) {
      sendOrderConfirmationEmail(order.toObject() as any).catch(() => {});
    }

    await logActivity({
      userId: user.userId,
      userName: user.name,
      userEmail: user.email,
      action: 'update',
      resource: 'order',
      resourceId: order._id.toString(),
      details: `Updated order ${order.orderNumber}: ${changes.join(', ')}`,
    });

    res.json({ success: true, data: order });
  } catch (error) {
    console.error('Error updating order:', error);
    res.status(500).json({ success: false, error: 'Failed to update order' });
  }
});

export default router;
