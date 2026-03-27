import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import Country from '@/lib/models/Country';
import { logActivity } from '@/lib/services/logger';
import { parseJsonBody } from '@/lib/validation/http';
import { countryCreateSchema } from '@/lib/validation/schemas';

export async function GET(request: NextRequest) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess('countries');
    if ('error' in auth) return auth.error;

    const activeOnly = request.nextUrl.searchParams.get('active') !== 'false';
    const query = activeOnly ? { isActive: true } : {};
    const countries = await Country.find(query)
      .sort({ sortOrder: 1, 'name.ar': 1 })
      .lean();
    return NextResponse.json({ success: true, data: countries });
  } catch (error) {
    console.error('Error fetching countries:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch countries' },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess('countries');
    if ('error' in auth) return auth.error;

    const parsed = await parseJsonBody(request, countryCreateSchema);
    if (!parsed.success) return parsed.response;
    const body = parsed.data;

    const existing = await Country.findOne({
      code: body.code?.toUpperCase(),
    });
    if (existing) {
      return NextResponse.json(
        { success: false, error: 'Country code already exists' },
        { status: 400 },
      );
    }

    const country = await Country.create(body);

    await logActivity({
      userId: auth.user.userId,
      userName: auth.user.name,
      userEmail: auth.user.email,
      action: 'create',
      resource: 'country',
      resourceId: country._id.toString(),
      details: `Created country: ${country.name.en} (${country.code})`,
    });

    return NextResponse.json({ success: true, data: country }, { status: 201 });
  } catch (error) {
    console.error('Error creating country:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to create country' },
      { status: 500 },
    );
  }
}
