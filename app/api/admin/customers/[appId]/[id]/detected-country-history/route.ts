import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import CustomerCountryHistory from '@/lib/models/CustomerCountryHistory';

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

    const history = await CustomerCountryHistory.find({
      customerId: id,
      appId,
    })
      .sort({ createdAt: -1 })
      .select(
        'previousCountry newCountry changedByUserName changedByUserEmail createdAt',
      )
      .lean();

    return NextResponse.json({
      success: true,
      data: history,
    });
  } catch (error) {
    console.error('Error fetching customer detected country history:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch history' },
      { status: 500 },
    );
  }
}
