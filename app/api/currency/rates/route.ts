import { NextRequest, NextResponse } from 'next/server';
import { getExchangeRates, convertCurrency } from '@/lib/services/currency';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = request.nextUrl;
    const base = searchParams.get('base') || 'SAR';
    const target = searchParams.get('target');
    const amount = searchParams.get('amount');

    if (target && amount) {
      const converted = await convertCurrency(parseFloat(amount), base, target);
      return NextResponse.json({
        success: true,
        data: {
          from: base.toUpperCase(),
          to: target.toUpperCase(),
          amount: parseFloat(amount),
          converted,
        },
      });
    }

    const rates = await getExchangeRates(base);
    return NextResponse.json({
      success: true,
      data: { base: base.toUpperCase(), rates },
    });
  } catch (error) {
    console.error('Error fetching exchange rates:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch exchange rates' },
      { status: 500 },
    );
  }
}
