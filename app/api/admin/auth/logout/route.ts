import { NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAppAuth } from '@/lib/auth';
import { logActivity } from '@/lib/services/logger';

export async function POST() {
  try {
    await connectDB();
    const auth = await requireAppAuth('admin_panel');
    if ('error' in auth) return auth.error;

    const { user } = auth;

    await logActivity({
      userId: user.userId,
      userName: user.name,
      userEmail: user.email,
      action: 'logout',
      resource: 'auth',
      details: 'Logged out',
    });

    const isProduction = process.env.NODE_ENV === 'production';
    const response = NextResponse.json({
      success: true,
      message: 'Logged out successfully',
    });

    response.cookies.set('admin-token', '', {
      httpOnly: true,
      secure: isProduction,
      sameSite: isProduction ? 'none' : 'lax',
      maxAge: 0,
      path: '/',
    });

    response.cookies.set('admin_panel-token', '', {
      httpOnly: true,
      secure: isProduction,
      sameSite: isProduction ? 'none' : 'lax',
      maxAge: 0,
      path: '/',
    });

    return response;
  } catch (error) {
    console.error('Error during logout:', error);
    return NextResponse.json(
      { success: false, error: 'Logout failed' },
      { status: 500 },
    );
  }
}
