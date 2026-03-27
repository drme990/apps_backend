import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import {
  createStandaloneCustomPayLink,
  PaymentLinkError,
} from '@/lib/services/payment-link';

export async function POST(request: NextRequest) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess('payments');
    if ('error' in auth) return auth.error;

    let customAmount: number | undefined;
    let currencyCode = '';
    let source = '';

    try {
      const body = await request.json();
      currencyCode =
        typeof body?.currencyCode === 'string' ? body.currencyCode.trim() : '';
      source = typeof body?.source === 'string' ? body.source.trim() : '';
      if (
        body &&
        body.customAmount !== undefined &&
        body.customAmount !== null &&
        body.customAmount !== ''
      ) {
        const parsed = Number(body.customAmount);
        if (Number.isFinite(parsed)) {
          customAmount = parsed;
        }
      }
    } catch {
      return NextResponse.json(
        { success: false, error: 'Invalid request payload' },
        { status: 400 },
      );
    }

    const user = {
      userId: auth.user.userId,
      name: auth.user.name,
      email: auth.user.email,
    };

    if (customAmount === undefined) {
      return NextResponse.json(
        {
          success: false,
          error: 'Custom amount is required for direct payment links.',
        },
        { status: 400 },
      );
    }

    if (!currencyCode) {
      return NextResponse.json(
        {
          success: false,
          error: 'Currency code is required for direct payment links.',
        },
        { status: 400 },
      );
    }

    const payload = await createStandaloneCustomPayLink({
      amount: customAmount,
      currencyCode,
      source,
      user,
    });

    return NextResponse.json({ success: true, data: payload });
  } catch (error) {
    if (error instanceof PaymentLinkError) {
      return NextResponse.json(
        { success: false, error: error.message },
        { status: error.status },
      );
    }

    console.error('Error creating payments pay link:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to create pay link' },
      { status: 500 },
    );
  }
}
