import { Request, Response, NextFunction } from 'express';
import { verifyToken, TokenPayload } from '../services/jwt';

// Extend Express Request to include user
declare global {
  namespace Express {
    interface Request {
      user?: TokenPayload;
    }
  }
}

export function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const token = req.cookies?.['admin-token'];

  if (!token) {
    res.status(401).json({ success: false, error: 'Authentication required' });
    return;
  }

  const payload = verifyToken(token);

  if (!payload) {
    res.status(401).json({ success: false, error: 'Invalid or expired token' });
    return;
  }

  req.user = payload;
  next();
}
