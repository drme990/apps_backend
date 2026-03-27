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
    return jwt.verify(token, JWT_SECRET) as TokenPayload;
  } catch {
    return null;
  }
}
