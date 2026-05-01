import { NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { getAuthUser } from '@/lib/auth';
import { getOutstandingBalanceLock } from '@/lib/services/outstanding-balance-lock';

type CheckoutSource = 'manasik' | 'ghadaq';

function toCheckoutSource(appId: string): CheckoutSource | null {
  if (appId === 'manasik' || appId === 'ghadaq') {
    return appId;
  }

  return null;
}

async function resolveAppUser() {
  const ghadaq = await getAuthUser('ghadaq');
  if (ghadaq) return ghadaq;

  const manasik = await getAuthUser('manasik');
  if (manasik) return manasik;

  return null;
}

export async function GET() {
  try {
    await connectDB();

    const user = await resolveAppUser();
    if (!user) {
      return NextResponse.json({
        success: true,
        data: {
          hasOutstandingBalance: false,
        },
      });
    }

    const checkoutSource = toCheckoutSource(user.appId);
    if (!checkoutSource) {
      return NextResponse.json({
        success: true,
        data: {
          hasOutstandingBalance: false,
        },
      });
    }

    const lockStatus = await getOutstandingBalanceLock({
      source: checkoutSource,
      userId: user.userId,
      // Only use userId for matching orders - no email/phone
    });

    return NextResponse.json({ success: true, data: lockStatus });
  } catch (error) {
    console.error('Error fetching outstanding balance lock status:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch lock status' },
      { status: 500 },
    );
  }
}
