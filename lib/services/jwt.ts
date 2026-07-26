import jwt from 'jsonwebtoken';
import type { AppId } from '@/lib/auth/app-users';

const JWT_SECRET = process.env.JWT_SECRET;

export interface TokenPayload {
  userId: string;
  appId: AppId;
  name: string;
  email: string;
  role?: 'admin' | 'super_admin';
  allowedPages?: string[];
}

export function generateToken(user: {
  _id: string;
  appId: AppId;
  name: string;
  email: string;
  role?: 'admin' | 'super_admin';
  allowedPages?: string[];
}): string {
  if (!JWT_SECRET) {
    throw new Error('JWT_SECRET is not defined in environment variables');
  }

  const payload: TokenPayload = {
    userId: user._id,
    appId: user.appId,
    name: user.name,
    email: user.email,
    ...(user.role ? { role: user.role } : {}),
    ...(user.allowedPages ? { allowedPages: user.allowedPages } : {}),
  };

  return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
}

export function verifyToken(token: string): TokenPayload | null {
  if (!JWT_SECRET) return null;
  try {
    const raw = jwt.verify(token, JWT_SECRET) as TokenPayload & {
      sub?: string;
    };

    // Accept design app tokens that use `sub` instead of `userId` (SSO).
    // The design app's custom JWT payload uses `sub`; the backend uses
    // `userId`. Map whichever is present.
    if (!raw.userId && raw.sub) {
      raw.userId = raw.sub;
    }

    // Design app tokens include appId: 'admin_panel'. Legacy or
    // third-party tokens may not include appId — default to admin_panel
    // so they're accepted by admin routes.
    if (!raw.appId) {
      raw.appId = 'admin_panel';
    }

    return raw;
  } catch {
    return null;
  }
}
