import { NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAppAuth } from '@/lib/auth';
import User from '@/lib/models/User';

export async function GET() {
  try {
    await connectDB();
    const auth = await requireAppAuth('admin_panel');
    if ('error' in auth) return auth.error;

    const fullUser = await User.findById(auth.user.userId);
    if (!fullUser) {
      return NextResponse.json(
        { success: false, error: 'User not found' },
        { status: 404 },
      );
    }

    return NextResponse.json({
      success: true,
      data: {
        user: {
          _id: fullUser._id,
          name: fullUser.name,
          email: fullUser.email,
          role: fullUser.role,
          allowedPages: fullUser.allowedPages,
          createdAt: fullUser.createdAt,
        },
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
