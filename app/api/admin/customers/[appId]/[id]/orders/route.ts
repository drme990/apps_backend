import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import Order from '@/lib/models/Order';

const querySchema = z.object({
  page: z
    .string()
    .optional()
    .transform((val) => (val ? parseInt(val, 10) : 1)),
  limit: z
    .string()
    .optional()
    .transform((val) => {
      const parsed = val ? parseInt(val, 10) : 20;
      return parsed > 100 ? 100 : parsed;
    }),
  status: z.string().optional(),
});

const ALL_ORDER_STATUSES = [
  'pending',
  'processing',
  'partial-paid',
  'paid',
  'completed',
  'failed',
  'refunded',
  'cancelled',
];

// Only these statuses should be returned
const VALID_ORDER_STATUSES = [
  'paid',
  'partial-paid',
  'completed',
  'refunded',
  'cancelled',
];

type OrderStatus = (typeof ALL_ORDER_STATUSES)[number];

type OrderItem = {
  productId: string;
  productName: {
    en: string;
    ar: string;
  };
  price: number;
  quantity: number;
  size?: string;
  total: number;
};

type OrderDTO = {
  _id: string;
  orderNumber: string;
  status: OrderStatus;
  totalAmount: number;
  paidAmount?: number;
  remainingAmount?: number;
  currency: string;
  source?: string;
  items: OrderItem[];
  billingData?: {
    fullName?: string;
    email?: string;
    phone?: string;
  };
  createdAt: Date;
  updatedAt: Date;
};

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ appId: string; id: string }> },
) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess('customers');
    if ('error' in auth) return auth.error;

    const { appId, id } = await params;

    if (appId !== 'ghadaq' && appId !== 'manasik') {
      return NextResponse.json(
        { success: false, error: 'Invalid app id' },
        { status: 400 },
      );
    }

    const parsed = querySchema.safeParse({
      page: request.nextUrl.searchParams.get('page') || undefined,
      limit: request.nextUrl.searchParams.get('limit') || undefined,
      status: request.nextUrl.searchParams.get('status') || undefined,
    });

    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: 'Invalid query parameters' },
        { status: 400 },
      );
    }

    const page = parsed.data.page || 1;
    const limit = parsed.data.limit || 20;
    const skip = (page - 1) * limit;

    const query: Record<string, unknown> = {
      userId: id,
      status: { $in: VALID_ORDER_STATUSES },
    };

    const [orders, totalCount] = await Promise.all([
      Order.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .select(
          'orderNumber status totalAmount paidAmount remainingAmount currency source items billingData createdAt updatedAt',
        )
        .lean(),
      Order.countDocuments(query),
    ]);

    const orderDTOs: OrderDTO[] = orders.map((order: any) => ({
      _id: String(order._id),
      orderNumber: order.orderNumber || '',
      status: order.status || 'pending',
      totalAmount: order.totalAmount || 0,
      paidAmount: order.paidAmount,
      remainingAmount: order.remainingAmount,
      currency: order.currency || 'USD',
      source: order.source,
      items: Array.isArray(order.items)
        ? order.items.map((item: any) => ({
            productId: item.productId || '',
            productName: item.productName || { en: 'Unknown', ar: 'غير معروف' },
            price: item.price || 0,
            quantity: item.quantity || 1,
            size: item.size || item.sizeName || item.sizeLabel,
            total: (item.price || 0) * (item.quantity || 1),
          }))
        : [],
      billingData: order.billingData,
      createdAt:
        order.createdAt instanceof Date ? order.createdAt : new Date(0),
      updatedAt:
        order.updatedAt instanceof Date ? order.updatedAt : new Date(0),
    }));

    return NextResponse.json({
      success: true,
      data: {
        orders: orderDTOs,
        pagination: {
          page,
          limit,
          total: totalCount,
          totalPages: Math.ceil(totalCount / limit),
        },
      },
    });
  } catch (error) {
    console.error('Error fetching customer orders:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch customer orders' },
      { status: 500 },
    );
  }
}
