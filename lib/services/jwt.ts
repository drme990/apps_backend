import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET;

export interface TokenPayload {
  userId: string;
  name: string;
  email: string;
  role: string;
  allowedPages?: string[];
}

export function generateToken(user: {
  _id: string;
  name: string;
  email: string;
  role: string;
  allowedPages?: string[];
}): string {
  if (!JWT_SECRET) {
    throw new Error('JWT_SECRET is not defined in environment variables');
  }

  const payload: TokenPayload = {
    userId: user._id,
    name: user.name,
    email: user.email,
    role: user.role,
    allowedPages: user.allowedPages || [],
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
