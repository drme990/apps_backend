import { NextRequest, NextResponse } from 'next/server';
import mongoose from 'mongoose';
import { z } from 'zod';
import { connectDB } from '@/lib/db';
import { getAuthUser } from '@/lib/auth';
import { AppId, getUserModelByAppId } from '@/lib/auth/app-users';
import { generateToken } from '@/lib/services/jwt';
import { logActivity } from '@/lib/services/logger';
import { checkRateLimit } from '@/lib/services/rate-limit';
import {
  consumeResetThrottle,
  createPasswordResetToken,
  markPasswordResetTokenUsed,
  sendPasswordResetEmail,
  verifyPasswordResetToken,
} from '@/lib/services/password-reset';
import { parseJsonBody } from '@/lib/validation/http';
import {
  forgotPasswordSchema,
  loginSchema,
  registerSchema,
  resetPasswordSchema,
} from '@/lib/validation/schemas';

type RouteApp = 'admin_panel' | 'ghadaq' | 'manasik';

type AuthUserDoc = {
  _id: mongoose.Types.ObjectId;
  name: string;
  email: string;
  password?: string;
  role?: 'admin' | 'super_admin';
  allowedPages?: string[];
  phone?: string;
  country?: string;
  isBanned?: boolean;
  comparePassword(candidatePassword: string): Promise<boolean>;
};

type AuthUserModel = mongoose.Model<AuthUserDoc>;

const updateProfileSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    email: z.string().email().optional(),
    phone: z.string().trim().optional(),
    country: z.string().trim().optional(),
    currentPassword: z.string().min(6).optional(),
    newPassword: z.string().min(6).optional(),
  })
  .refine(
    (payload) => {
      // If one password field is provided, the other must be too
      if (
        (payload.currentPassword && !payload.newPassword) ||
        (!payload.currentPassword && payload.newPassword)
      ) {
        return false;
      }
      return Object.keys(payload).length > 0;
    },
    {
      message: 'Invalid payload or missing password fields',
    },
  );

const registerPayloadSchema = registerSchema.omit({ appId: true });

function mapRouteAppToAppId(app: RouteApp): AppId {
  return app;
}

function toPublicUser(user: AuthUserDoc, appId: AppId) {
  return {
    _id: user._id,
    name: user.name,
    email: user.email,
    appId,
    ...(appId !== 'admin_panel'
      ? {
          phone: user.phone || '',
          country: user.country || '',
        }
      : {}),
    ...(appId === 'admin_panel'
      ? {
          role: user.role,
          allowedPages: user.allowedPages || [],
        }
      : {}),
  };
}

function setAuthCookies(response: NextResponse, appId: AppId, token: string) {
  const isProduction = process.env.NODE_ENV === 'production';

  response.cookies.set(`${appId}-token`, token, {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? 'none' : 'lax',
    maxAge: 7 * 24 * 60 * 60,
    path: '/',
  });
}

function clearAuthCookies(response: NextResponse, appId: AppId) {
  const isProduction = process.env.NODE_ENV === 'production';

  response.cookies.set(`${appId}-token`, '', {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? 'none' : 'lax',
    maxAge: 0,
    path: '/',
  });
}

export async function loginForApp(request: NextRequest, app: RouteApp) {
  try {
    await connectDB();

    const parsed = await parseJsonBody(request, loginSchema);
    if (!parsed.success) return parsed.response;

    const appId = mapRouteAppToAppId(app);
    const { email, password } = parsed.data;

    const rateLimitKey = `login:${appId}:${email.toLowerCase()}`;
    const rateLimit = await checkRateLimit(rateLimitKey, {
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

    const UserModel = getUserModelByAppId(appId) as unknown as AuthUserModel;
    const user = await UserModel.findOne({ email: email.toLowerCase() }).select(
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

    if (appId !== 'admin_panel' && user.isBanned) {
      return NextResponse.json(
        { success: false, error: 'Your account has been banned' },
        { status: 403 },
      );
    }

    const token = generateToken({
      _id: user._id.toString(),
      appId,
      name: user.name,
      email: user.email,
      role: appId === 'admin_panel' ? user.role : undefined,
      allowedPages:
        appId === 'admin_panel' ? user.allowedPages || [] : undefined,
    });

    if (appId === 'admin_panel') {
      await logActivity({
        userId: user._id.toString(),
        userName: user.name,
        userEmail: user.email,
        action: 'login',
        resource: 'auth',
        details: `Logged in to ${appId} successfully`,
      });
    }

    const response = NextResponse.json({
      success: true,
      data: {
        user: toPublicUser(user, appId),
      },
    });

    setAuthCookies(response, appId, token);
    return response;
  } catch (error) {
    console.error('Error during login:', error);
    return NextResponse.json(
      { success: false, error: 'Login failed' },
      { status: 500 },
    );
  }
}

export async function registerForApp(request: NextRequest, app: RouteApp) {
  try {
    await connectDB();

    const appId = mapRouteAppToAppId(app);
    const parsed = await parseJsonBody(request, registerPayloadSchema);
    if (!parsed.success) return parsed.response;

    const { name, email, password, phone, country } = parsed.data;
    const UserModel = getUserModelByAppId(appId) as unknown as AuthUserModel;

    const existing = await UserModel.findOne({ email: email.toLowerCase() });
    if (existing) {
      return NextResponse.json(
        { success: false, error: 'Email already exists' },
        { status: 400 },
      );
    }

    const createPayload: Record<string, unknown> = {
      name,
      email: email.toLowerCase(),
      password,
      appId,
    };

    if (appId === 'admin_panel') {
      createPayload.role = 'admin';
      createPayload.allowedPages = [];
    } else {
      createPayload.phone = phone || '';
      createPayload.country = country || '';
    }

    const user = await UserModel.create(createPayload);

    const token = generateToken({
      _id: user._id.toString(),
      appId,
      name: user.name,
      email: user.email,
      role: appId === 'admin_panel' ? user.role : undefined,
      allowedPages:
        appId === 'admin_panel' ? user.allowedPages || [] : undefined,
    });

    const response = NextResponse.json(
      {
        success: true,
        data: {
          user: toPublicUser(user, appId),
        },
      },
      { status: 201 },
    );

    setAuthCookies(response, appId, token);
    return response;
  } catch (error) {
    console.error('Error during register:', error);
    return NextResponse.json(
      { success: false, error: 'Registration failed' },
      { status: 500 },
    );
  }
}

export async function getProfileForApp(app: RouteApp) {
  try {
    await connectDB();

    const appId = mapRouteAppToAppId(app);
    const authUser = await getAuthUser(appId);
    if (!authUser) {
      return NextResponse.json(
        { success: false, error: 'Authentication required' },
        { status: 401 },
      );
    }

    const UserModel = getUserModelByAppId(appId) as unknown as AuthUserModel;
    const user = await UserModel.findById(authUser.userId);

    if (!user) {
      return NextResponse.json(
        { success: false, error: 'User not found' },
        { status: 404 },
      );
    }

    if (appId !== 'admin_panel' && user.isBanned) {
      return NextResponse.json(
        { success: false, error: 'Your account has been banned' },
        { status: 403 },
      );
    }

    return NextResponse.json({
      success: true,
      data: toPublicUser(user, appId),
    });
  } catch (error) {
    console.error('Error fetching auth user profile:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch profile' },
      { status: 500 },
    );
  }
}

export async function getSessionForApp(app: RouteApp) {
  // Keeping this for auth check uses (e.g. Header), but returning same structure
  return getProfileForApp(app);
}

export async function updateProfileForApp(request: NextRequest, app: RouteApp) {
  try {
    await connectDB();

    const appId = mapRouteAppToAppId(app);
    const authUser = await getAuthUser(appId);
    if (!authUser) {
      return NextResponse.json(
        { success: false, error: 'Authentication required' },
        { status: 401 },
      );
    }

    const parsed = await parseJsonBody(request, updateProfileSchema);
    if (!parsed.success) return parsed.response;

    const updatePayload: Record<string, string> = {};
    if (typeof parsed.data.name === 'string') {
      updatePayload.name = parsed.data.name;
    }

    if (typeof parsed.data.email === 'string') {
      updatePayload.email = parsed.data.email.toLowerCase();
    }

    if (appId !== 'admin_panel') {
      if (typeof parsed.data.phone === 'string') {
        updatePayload.phone = parsed.data.phone;
      }
      if (typeof parsed.data.country === 'string') {
        updatePayload.country = parsed.data.country;
      }
    }

    const UserModel = getUserModelByAppId(appId) as unknown as AuthUserModel;

    if (typeof updatePayload.email === 'string') {
      const existingUser = await UserModel.findOne({
        email: updatePayload.email,
        _id: { $ne: authUser.userId },
      });

      if (existingUser) {
        return NextResponse.json(
          { success: false, error: 'Email already exists' },
          { status: 400 },
        );
      }
    }

    const userDoc = await UserModel.findById(authUser.userId);
    if (!userDoc) {
      return NextResponse.json(
        { success: false, error: 'User not found' },
        { status: 404 },
      );
    }

    if (parsed.data.currentPassword && parsed.data.newPassword) {
      if (!userDoc.comparePassword) {
        return NextResponse.json(
          {
            success: false,
            error: 'Password update not supported for this user',
          },
          { status: 400 },
        );
      }
      const isMatch = await userDoc.comparePassword(
        parsed.data.currentPassword,
      );
      if (!isMatch) {
        return NextResponse.json(
          { success: false, error: 'Incorrect current password' },
          { status: 400 },
        );
      }
      userDoc.password = parsed.data.newPassword;
    }

    if (updatePayload.name) userDoc.name = updatePayload.name;
    if (updatePayload.email) userDoc.email = updatePayload.email;
    if (updatePayload.phone) userDoc.phone = updatePayload.phone;
    if (updatePayload.country) userDoc.country = updatePayload.country;

    const updatedUser = await userDoc.save();

    return NextResponse.json({
      success: true,
      data: toPublicUser(updatedUser, appId),
    });
  } catch (error) {
    console.error('Error updating auth user profile:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to update profile' },
      { status: 500 },
    );
  }
}

export async function logoutForApp(app: RouteApp) {
  try {
    const appId = mapRouteAppToAppId(app);
    const authUser = await getAuthUser(appId);
    if (!authUser) {
      return NextResponse.json(
        { success: false, error: 'Authentication required' },
        { status: 401 },
      );
    }

    const response = NextResponse.json({
      success: true,
      message: 'Logged out successfully',
    });

    clearAuthCookies(response, appId);
    return response;
  } catch (error) {
    console.error('Error during logout:', error);
    return NextResponse.json(
      { success: false, error: 'Logout failed' },
      { status: 500 },
    );
  }
}

export async function forgotPasswordForApp(
  request: NextRequest,
  app: Exclude<RouteApp, 'admin_panel'>,
) {
  try {
    await connectDB();

    const parsed = await parseJsonBody(request, forgotPasswordSchema);
    if (!parsed.success) return parsed.response;

    const appId = mapRouteAppToAppId(app);
    const normalizedEmail = parsed.data.email.trim().toLowerCase();

    const throttle = await consumeResetThrottle(app, normalizedEmail);
    if (!throttle.allowed) {
      return NextResponse.json(
        {
          success: false,
          error: throttle.message,
          code:
            throttle.reason === 'banned'
              ? 'PASSWORD_RESET_BANNED'
              : 'PASSWORD_RESET_COOLDOWN',
          retryAfterSeconds: throttle.retryAfterSeconds,
        },
        { status: 429 },
      );
    }

    const UserModel = getUserModelByAppId(appId) as unknown as AuthUserModel;
    const user = await UserModel.findOne({ email: normalizedEmail });

    // Never reveal if email exists.
    if (user) {
      const token = await createPasswordResetToken(app, normalizedEmail);
      await sendPasswordResetEmail(app, normalizedEmail, token);
    }

    return NextResponse.json({
      success: true,
      message: 'If this email exists, a reset link was sent',
      nextRetrySeconds: throttle.nextRetrySeconds,
      attempt: throttle.attempt,
    });
  } catch (error) {
    console.error('Error during forgot password:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to process request' },
      { status: 500 },
    );
  }
}

export async function resetPasswordForApp(
  request: NextRequest,
  app: Exclude<RouteApp, 'admin_panel'>,
) {
  try {
    await connectDB();

    const parsed = await parseJsonBody(request, resetPasswordSchema);
    if (!parsed.success) return parsed.response;

    const appId = mapRouteAppToAppId(app);
    const normalizedEmail = parsed.data.email.trim().toLowerCase();

    const tokenDoc = await verifyPasswordResetToken(
      app,
      normalizedEmail,
      parsed.data.token,
    );

    if (!tokenDoc) {
      return NextResponse.json(
        { success: false, error: 'Invalid or expired token' },
        { status: 400 },
      );
    }

    const UserModel = getUserModelByAppId(appId) as unknown as AuthUserModel;
    const user = await UserModel.findOne({ email: normalizedEmail }).select(
      '+password',
    );

    if (!user) {
      return NextResponse.json(
        { success: false, error: 'User not found' },
        { status: 404 },
      );
    }

    user.password = parsed.data.password;
    await user.save();

    await markPasswordResetTokenUsed(tokenDoc._id.toString());

    return NextResponse.json({
      success: true,
      message: 'Password reset successfully',
    });
  } catch (error) {
    console.error('Error during reset password:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to reset password' },
      { status: 500 },
    );
  }
}

export const updateSessionForApp = updateProfileForApp;
