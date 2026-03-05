import { Router, Request, Response } from 'express';
import User from '../../models/User';
import { generateToken } from '../../services/jwt';
import { logActivity } from '../../services/logger';
import { checkRateLimit } from '../../services/rate-limit';
import { requireAuth } from '../../middleware/auth';

const router = Router();

// POST /api/admin/auth/login
router.post('/login', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      res
        .status(400)
        .json({ success: false, error: 'Email and password are required' });
      return;
    }

    // Rate limiting
    const rateLimitKey = `login:${email.toLowerCase()}`;
    const rateLimit = checkRateLimit(rateLimitKey, {
      maxAttempts: 5,
      windowSeconds: 15 * 60,
    });
    if (!rateLimit.allowed) {
      res.status(429).json({
        success: false,
        error: `Too many login attempts. Try again in ${Math.ceil(rateLimit.resetInSeconds / 60)} minutes`,
      });
      return;
    }

    const user = await User.findOne({ email: email.toLowerCase() }).select(
      '+password',
    );
    if (!user) {
      res
        .status(401)
        .json({ success: false, error: 'Invalid email or password' });
      return;
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      res
        .status(401)
        .json({ success: false, error: 'Invalid email or password' });
      return;
    }

    const token = generateToken({
      _id: user._id.toString(),
      name: user.name,
      email: user.email,
      role: user.role,
      allowedPages: user.allowedPages,
    });

    res.cookie('admin-token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      path: '/',
    });

    await logActivity({
      userId: user._id.toString(),
      userName: user.name,
      userEmail: user.email,
      action: 'login',
      resource: 'auth',
      details: 'Logged in successfully',
    });

    res.json({
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
  } catch (error) {
    console.error('Error during login:', error);
    res.status(500).json({ success: false, error: 'Login failed' });
  }
});

// POST /api/admin/auth/logout
router.post('/logout', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user!;

    await logActivity({
      userId: user.userId,
      userName: user.name,
      userEmail: user.email,
      action: 'logout',
      resource: 'auth',
      details: 'Logged out',
    });

    res.cookie('admin-token', '', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
      maxAge: 0,
      path: '/',
    });

    res.json({ success: true, message: 'Logged out successfully' });
  } catch (error) {
    console.error('Error during logout:', error);
    res.status(500).json({ success: false, error: 'Logout failed' });
  }
});

// GET /api/admin/auth/me
router.get('/me', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const fullUser = await User.findById(user.userId);

    if (!fullUser) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }

    res.json({
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
    res.status(500).json({ success: false, error: 'Failed to fetch user' });
  }
});

export default router;
