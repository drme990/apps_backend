import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import Country from '@/lib/models/Country';
import { logActivity } from '@/lib/services/logger';
import { parseJsonBody } from '@/lib/validation/http';
import { z } from 'zod';

const currencyReorderSchema = z.object({
  orderedCurrencies: z.array(z.string()).min(1),
});

export async function PUT(request: NextRequest) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess('countries');
    if ('error' in auth) return auth.error;

    const parsed = await parseJsonBody(request, currencyReorderSchema);
    if (!parsed.success) return parsed.response;
    const { orderedCurrencies } = parsed.data;

    // Build bulk operations: for each currency in the ordered list,
    // set currencyOrder on ALL countries that use that currency.
    const bulkOps = orderedCurrencies.map((currencyCode: string, index: number) => ({
      updateMany: {
        filter: { currencyCode: currencyCode.toUpperCase() },
        update: { $set: { currencyOrder: index } },
      },
    }));

    // Also nullify currencyOrder for currencies NOT in the ordered list
    // (so they fall back to alphabetical ordering)
    await Country.updateMany(
      { currencyCode: { $nin: orderedCurrencies.map((c) => c.toUpperCase()) } },
      { $set: { currencyOrder: null } },
    );

    if (bulkOps.length > 0) {
      await Country.bulkWrite(bulkOps);
    }

    await logActivity({
      userId: auth.user.userId,
      userName: auth.user.name,
      userEmail: auth.user.email,
      action: 'update',
      resource: 'country',
      details: `Reordered ${orderedCurrencies.length} currencies`,
    });

    return NextResponse.json({
      success: true,
      message: 'Currencies reordered successfully',
    });
  } catch (error) {
    console.error('Error reordering currencies:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to reorder currencies' },
      { status: 500 },
    );
  }
}
