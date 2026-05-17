import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import CustomerRefHistory from '@/lib/models/CustomerRefHistory';

export async function GET(
  _request: NextRequest,
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

    const history = await CustomerRefHistory.find({ customerId: id, appId })
      .sort({ createdAt: -1 })
      .lean();

    return NextResponse.json({
      success: true,
      data: {
        history: history.map((entry) => ({
          _id: String(entry._id),
          customerId: entry.customerId,
          appId: entry.appId,
          customerName: entry.customerName || '',
          customerEmail: entry.customerEmail || '',
          previousRef: entry.previousRef ?? null,
          newRef: entry.newRef ?? null,
          changedByUserId: entry.changedByUserId,
          changedByUserName: entry.changedByUserName,
          changedByUserEmail: entry.changedByUserEmail,
          changeSource: entry.changeSource,
          createdAt: entry.createdAt,
        })),
      },
    });
  } catch (error) {
    console.error('Error fetching customer ref history:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch customer ref history' },
      { status: 500 },
    );
  }
}
