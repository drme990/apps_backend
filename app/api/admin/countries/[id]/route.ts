import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import Country from '@/lib/models/Country';
import { logActivity } from '@/lib/services/logger';
import { parseJsonBody } from '@/lib/validation/http';
import { countryUpdateSchema } from '@/lib/validation/schemas';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess('countries');
    if ('error' in auth) return auth.error;

    const { id } = await params;
    const country = await Country.findById(id).lean();
    if (!country) {
      return NextResponse.json(
        { success: false, error: 'Country not found' },
        { status: 404 },
      );
    }
    return NextResponse.json({ success: true, data: country });
  } catch (error) {
    console.error('Error fetching country:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch country' },
      { status: 500 },
    );
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess('countries');
    if ('error' in auth) return auth.error;

    const { id } = await params;
    const parsed = await parseJsonBody(request, countryUpdateSchema);
    if (!parsed.success) return parsed.response;
    const body = parsed.data;
    const country = await Country.findByIdAndUpdate(id, body, {
      new: true,
      runValidators: true,
    });
    if (!country) {
      return NextResponse.json(
        { success: false, error: 'Country not found' },
        { status: 404 },
      );
    }

    await logActivity({
      userId: auth.user.userId,
      userName: auth.user.name,
      userEmail: auth.user.email,
      action: 'update',
      resource: 'country',
      resourceId: country._id.toString(),
      details: `Updated country: ${country.name.en} (${country.code})`,
    });

    return NextResponse.json({ success: true, data: country });
  } catch (error) {
    console.error('Error updating country:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to update country' },
      { status: 500 },
    );
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess('countries');
    if ('error' in auth) return auth.error;

    const { id } = await params;
    const country = await Country.findByIdAndDelete(id);
    if (!country) {
      return NextResponse.json(
        { success: false, error: 'Country not found' },
        { status: 404 },
      );
    }

    await logActivity({
      userId: auth.user.userId,
      userName: auth.user.name,
      userEmail: auth.user.email,
      action: 'delete',
      resource: 'country',
      resourceId: id,
      details: `Deleted country: ${country.name.en} (${country.code})`,
    });

    return NextResponse.json({
      success: true,
      message: 'Country deleted successfully',
    });
  } catch (error) {
    console.error('Error deleting country:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to delete country' },
      { status: 500 },
    );
  }
}
