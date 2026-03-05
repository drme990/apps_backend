import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import User from '@/lib/models/User';
import { generateToken } from '@/lib/services/jwt';
import { logActivity } from '@/lib/services/logger';
import { checkRateLimit } from '@/lib/services/rate-limit';

export async function POST(request: NextRequest) {
  try {
    await connectDB();
    const { email, password } = await request.json();

    if (!email || !password) {
      return NextResponse.json(
        { success: false, error: 'Email and password are required' },
        { status: 400 },
      );
    }

    const rateLimitKey = `login:${email.toLowerCase()}`;
    const rateLimit = checkRateLimit(rateLimitKey, {
      maxAttempts: 5,
      windowSeconds: 15 * 60,
    });
    if (!rateLimit.allowed) {
      return NextResponse.json(
        {
          success: false,
          error: `Too many login attempts. Try again in ${Math.ceil(rateLimit.resetInSeconds / 60)} minutes`,
        },
        { status: 429 },
      );
    }

    const user = await User.findOne({ email: email.toLowerCase() }).select(
      '+password',
    );
    if (!user) {
      return NextResponse.json(
        { success: false, error: 'Invalid email or password' },
        { status: 401 },
      );
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return NextResponse.json(
        { success: false, error: 'Invalid email or password' },
        { status: 401 },
      );
    }

    const token = generateToken({
      _id: user._id.toString(),
      name: user.name,
      email: user.email,
      role: user.role,
      allowedPages: user.allowedPages,
    });

    await logActivity({
      userId: user._id.toString(),
      userName: user.name,
      userEmail: user.email,
      action: 'login',
      resource: 'auth',
      details: 'Logged in successfully',
    });

    const isProduction = process.env.NODE_ENV === 'production';
    const response = NextResponse.json({
      success: true,
      data: {
        user: {
          _id: user._id,
          name: user.name,
          email: user.email,
          role: user.role,
          allowedPages: user.allowedPages,
        },
      },
    });

    response.cookies.set('admin-token', token, {
      httpOnly: true,
      secure: isProduction,
      sameSite: isProduction ? 'none' : 'lax',
      maxAge: 7 * 24 * 60 * 60,
      path: '/',
    });

    return response;
  } catch (error) {
    console.error('Error during login:', error);
    return NextResponse.json(
      { success: false, error: 'Login failed' },
      { status: 500 },
    );
  }
}
