import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import User from '@/lib/models/User';
import { logActivity } from '@/lib/services/logger';
import { parseJsonBody } from '@/lib/validation/http';
import { userUpdateSchema } from '@/lib/validation/schemas';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess('admins');
    if ('error' in auth) return auth.error;

    const { id } = await params;
    const user = await User.findById(id);
    if (!user) {
      return NextResponse.json(
        { success: false, error: 'User not found' },
        { status: 404 },
      );
    }

    return NextResponse.json({
      success: true,
      data: {
        _id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        allowedPages: user.allowedPages,
        createdAt: user.createdAt,
      },
    });
  } catch (error) {
    console.error('Error fetching user:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch user' },
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
    const auth = await requireAdminPageAccess('admins');
    if ('error' in auth) return auth.error;

    if (auth.user.role !== 'super_admin') {
      return NextResponse.json(
        { success: false, error: 'Only super admins can update users' },
        { status: 403 },
      );
    }

    const { id } = await params;
    const targetUser = await User.findById(id).select('+password');
    if (!targetUser) {
      return NextResponse.json(
        { success: false, error: 'User not found' },
        { status: 404 },
      );
    }

    if (
      targetUser.role === 'super_admin' &&
      auth.user.userId !== targetUser._id.toString()
    ) {
      return NextResponse.json(
        { success: false, error: 'Cannot modify another super admin' },
        { status: 403 },
      );
    }

    const parsed = await parseJsonBody(request, userUpdateSchema);
    if (!parsed.success) return parsed.response;
    const { name, email, password, role, allowedPages } = parsed.data;
    if (name) targetUser.name = name;
    if (email) targetUser.email = email;
    if (password) targetUser.password = password;
    if (role) targetUser.role = role;
    if (allowedPages !== undefined) targetUser.allowedPages = allowedPages;

    await targetUser.save();

    await logActivity({
      userId: auth.user.userId,
      userName: auth.user.name,
      userEmail: auth.user.email,
      action: 'update',
      resource: 'user',
      resourceId: targetUser._id.toString(),
      details: `Updated user: ${targetUser.name} (${targetUser.email})`,
    });

    return NextResponse.json({
      success: true,
      data: {
        _id: targetUser._id,
        name: targetUser.name,
        email: targetUser.email,
        role: targetUser.role,
        allowedPages: targetUser.allowedPages,
      },
    });
  } catch (error) {
    console.error('Error updating user:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to update user' },
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
    const auth = await requireAdminPageAccess('admins');
    if ('error' in auth) return auth.error;

    if (auth.user.role !== 'super_admin') {
      return NextResponse.json(
        { success: false, error: 'Only super admins can delete users' },
        { status: 403 },
      );
    }

    const { id } = await params;

    if (auth.user.userId === id) {
      return NextResponse.json(
        { success: false, error: 'Cannot delete your own account' },
        { status: 400 },
      );
    }

    const targetUser = await User.findById(id);
    if (!targetUser) {
      return NextResponse.json(
        { success: false, error: 'User not found' },
        { status: 404 },
      );
    }

    if (targetUser.role === 'super_admin') {
      return NextResponse.json(
        { success: false, error: 'Cannot delete a super admin' },
        { status: 403 },
      );
    }

    await User.findByIdAndDelete(id);

    await logActivity({
      userId: auth.user.userId,
      userName: auth.user.name,
      userEmail: auth.user.email,
      action: 'delete',
      resource: 'user',
      resourceId: id,
      details: `Deleted user: ${targetUser.name} (${targetUser.email})`,
    });

    return NextResponse.json({
      success: true,
      message: 'User deleted successfully',
    });
  } catch (error) {
    console.error('Error deleting user:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to delete user' },
      { status: 500 },
    );
  }
}
