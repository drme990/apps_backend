import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import User from '@/lib/models/User';
import { logActivity } from '@/lib/services/logger';
import { parseJsonBody } from '@/lib/validation/http';
import { userCreateSchema } from '@/lib/validation/schemas';

export async function GET() {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess('admins');
    if ('error' in auth) return auth.error;

    const users = await User.find().sort({ createdAt: -1 });
    return NextResponse.json({ success: true, data: { users } });
  } catch (error) {
    console.error('Error fetching users:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch users' },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess('admins');
    if ('error' in auth) return auth.error;

    if (auth.user.role !== 'super_admin') {
      return NextResponse.json(
        { success: false, error: 'Only super admins can create users' },
        { status: 403 },
      );
    }

    const parsed = await parseJsonBody(request, userCreateSchema);
    if (!parsed.success) return parsed.response;
    const { name, email, password, role, allowedPages } = parsed.data;

    const existingUser = await User.findOne({ email: email?.toLowerCase() });
    if (existingUser) {
      return NextResponse.json(
        { success: false, error: 'Email already exists' },
        { status: 400 },
      );
    }

    const user = await User.create({
      name,
      email,
      password,
      role: role || 'admin',
      allowedPages: allowedPages || [],
    });

    await logActivity({
      userId: auth.user.userId,
      userName: auth.user.name,
      userEmail: auth.user.email,
      action: 'create',
      resource: 'user',
      resourceId: user._id.toString(),
      details: `Created user: ${user.name} (${user.email}) with role: ${user.role}`,
    });

    return NextResponse.json(
      {
        success: true,
        data: {
          _id: user._id,
          name: user.name,
          email: user.email,
          role: user.role,
          allowedPages: user.allowedPages,
        },
      },
      { status: 201 },
    );
  } catch (error) {
    console.error('Error creating user:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to create user' },
      { status: 500 },
    );
  }
}
