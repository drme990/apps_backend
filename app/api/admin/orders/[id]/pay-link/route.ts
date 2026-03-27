import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import Order from '@/lib/models/Order';
import {
  createPayLinkForOrder,
  PaymentLinkError,
} from '@/lib/services/payment-link';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess('orders');
    if ('error' in auth) return auth.error;

    const { id } = await params;
    const order = await Order.findById(id).lean();

    if (!order) {
      return NextResponse.json(
        { success: false, error: 'Order not found' },
        { status: 404 },
      );
    }

    let customAmount: number | undefined;
    try {
      const body = await request.json();
      if (
        body &&
        typeof body.customAmount === 'number' &&
        Number.isFinite(body.customAmount)
      ) {
        customAmount = body.customAmount;
      }
    } catch {
      // Allow empty request body for default remaining-amount links.
    }

    const payload = await createPayLinkForOrder({
      order,
      user: {
        userId: auth.user.userId,
        name: auth.user.name,
        email: auth.user.email,
      },
      customAmount,
    });

    return NextResponse.json({
      success: true,
      data: payload,
    });
  } catch (error) {
    if (error instanceof PaymentLinkError) {
      return NextResponse.json(
        { success: false, error: error.message },
        { status: error.status },
      );
    }

    console.error('Error creating pay link:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to create pay link' },
      { status: 500 },
    );
  }
}
