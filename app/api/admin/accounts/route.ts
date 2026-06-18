import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import Account from '@/lib/models/Account';
import { logActivity } from '@/lib/services/logger';
import { parseJsonBody } from '@/lib/validation/http';
import { accountCreateSchema } from '@/lib/validation/schemas';

export async function GET(request: NextRequest) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess('accounts');
    if ('error' in auth) return auth.error;

    const { searchParams } = new URL(request.url);
    const page = Math.max(1, parseInt(searchParams.get('page') || '1'));
    const limit = Math.min(200, Math.max(1, parseInt(searchParams.get('limit') || '50')));
    const skip = (page - 1) * limit;
    const type = searchParams.get('type');
    const isActiveParam = searchParams.get('isActive');
    const search = searchParams.get('search');

    const filter: Record<string, unknown> = {};
    if (type && type !== 'all') filter.type = type;
    if (isActiveParam !== null) filter.isActive = isActiveParam !== 'false';
    if (search) filter.name = { $regex: search, $options: 'i' };

    const [accounts, total] = await Promise.all([
      Account.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Account.countDocuments(filter),
    ]);

    return NextResponse.json({
      success: true,
      data: {
        accounts,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      },
    });
  } catch (error) {
    console.error('Error fetching accounts:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch accounts' },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess('accounts');
    if ('error' in auth) return auth.error;

    const parsed = await parseJsonBody(request, accountCreateSchema);
    if (!parsed.success) return parsed.response;

    const account = await Account.create(parsed.data);

    await logActivity({
      userId: auth.user.userId,
      userName: auth.user.name,
      userEmail: auth.user.email,
      action: 'create',
      resource: 'account',
      resourceId: account._id.toString(),
      details: `Created account: ${account.name} (${account.type}) — ${account.currency}`,
    });

    return NextResponse.json({ success: true, data: account }, { status: 201 });
  } catch (error) {
    console.error('Error creating account:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to create account' },
      { status: 500 },
    );
  }
}
