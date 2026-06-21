import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import CustomerHistory from '@/lib/models/CustomerHistory';

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

    const history = await CustomerHistory.find({
      customerId: id,
      appId,
    })
      .sort({ createdAt: -1 })
      .lean();

    const refHistory = [];
    const countryHistory = [];

    for (const entry of history) {
      const base = {
        _id: String(entry._id),
        changedByUserName: entry.changedByUserName,
        changedByUserEmail: entry.changedByUserEmail,
        createdAt: entry.createdAt,
      };

      if (entry.type === 'ref') {
        refHistory.push({
          ...base,
          previousRef: entry.previousValue ?? null,
          newRef: entry.newValue ?? null,
          changeSource: entry.changeSource,
        });
      } else {
        countryHistory.push({
          ...base,
          previousCountry: entry.previousValue ?? null,
          newCountry: entry.newValue ?? null,
        });
      }
    }

    return NextResponse.json({
      success: true,
      data: {
        refHistory,
        countryHistory,
      },
    });
  } catch (error) {
    console.error('Error fetching customer history:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch customer history' },
      { status: 500 },
    );
  }
}
