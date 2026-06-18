import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import Account from '@/lib/models/Account';
import { logActivity } from '@/lib/services/logger';
import { parseJsonBody } from '@/lib/validation/http';
import { accountUpdateSchema } from '@/lib/validation/schemas';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess('accounts');
    if ('error' in auth) return auth.error;

    const { id } = await params;
    const account = await Account.findById(id).lean();
    if (!account) {
      return NextResponse.json(
        { success: false, error: 'Account not found' },
        { status: 404 },
      );
    }
    return NextResponse.json({ success: true, data: account });
  } catch (error) {
    console.error('Error fetching account:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch account' },
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
    const auth = await requireAdminPageAccess('accounts');
    if ('error' in auth) return auth.error;

    const { id } = await params;
    const parsed = await parseJsonBody(request, accountUpdateSchema);
    if (!parsed.success) return parsed.response;

    const account = await Account.findByIdAndUpdate(id, parsed.data, {
      new: true,
      runValidators: true,
    });
    if (!account) {
      return NextResponse.json(
        { success: false, error: 'Account not found' },
        { status: 404 },
      );
    }

    await logActivity({
      userId: auth.user.userId,
      userName: auth.user.name,
      userEmail: auth.user.email,
      action: 'update',
      resource: 'account',
      resourceId: account._id.toString(),
      details: `Updated account: ${account.name}`,
    });

    return NextResponse.json({ success: true, data: account });
  } catch (error) {
    console.error('Error updating account:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to update account' },
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
    const auth = await requireAdminPageAccess('accounts');
    if ('error' in auth) return auth.error;

    const { id } = await params;
    const account = await Account.findByIdAndDelete(id);
    if (!account) {
      return NextResponse.json(
        { success: false, error: 'Account not found' },
        { status: 404 },
      );
    }

    await logActivity({
      userId: auth.user.userId,
      userName: auth.user.name,
      userEmail: auth.user.email,
      action: 'delete',
      resource: 'account',
      resourceId: id,
      details: `Deleted account: ${account.name} (${account.type})`,
    });

    return NextResponse.json({
      success: true,
      message: 'Account deleted successfully',
    });
  } catch (error) {
    console.error('Error deleting account:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to delete account' },
      { status: 500 },
    );
  }
}
