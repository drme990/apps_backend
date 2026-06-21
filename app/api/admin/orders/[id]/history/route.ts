import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import OrderChangeHistory from '@/lib/models/OrderChangeHistory';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess('orders');
    if ('error' in auth) return auth.error;

    const { id } = await params;

    const history = await OrderChangeHistory.find({ orderId: id })
      .sort({ createdAt: -1 })
      .lean();

    const mapped = history.map((entry) => ({
      _id: String(entry._id),
      changeType: entry.changeType,
      previousValue: entry.previousValue,
      newValue: entry.newValue,
      changedByUserName: entry.changedByUserName,
      changedByUserEmail: entry.changedByUserEmail,
      createdAt: entry.createdAt,
    }));

    return NextResponse.json({
      success: true,
      data: mapped,
    });
  } catch (error) {
    console.error('Error fetching order history:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch order history' },
      { status: 500 },
    );
  }
}
