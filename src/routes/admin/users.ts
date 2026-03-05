import { Router, Request, Response } from 'express';
import User from '../../models/User';
import { requireAuth } from '../../middleware/auth';
import { logActivity } from '../../services/logger';

const router = Router();

// All user routes require authentication
router.use(requireAuth);

// GET /api/admin/users
router.get('/', async (req: Request, res: Response) => {
  try {
    const users = await User.find().sort({ createdAt: -1 });
    res.json({ success: true, data: { users } });
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch users' });
  }
});

// POST /api/admin/users
router.post('/', async (req: Request, res: Response) => {
  try {
    const currentUser = req.user!;
    if (currentUser.role !== 'super_admin') {
      res
        .status(403)
        .json({ success: false, error: 'Only super admins can create users' });
      return;
    }

    const { name, email, password, role, allowedPages } = req.body;

    const existingUser = await User.findOne({ email: email?.toLowerCase() });
    if (existingUser) {
      res.status(400).json({ success: false, error: 'Email already exists' });
      return;
    }

    const user = await User.create({
      name,
      email,
      password,
      role: role || 'admin',
      allowedPages: allowedPages || [],
    });

    await logActivity({
      userId: currentUser.userId,
      userName: currentUser.name,
      userEmail: currentUser.email,
      action: 'create',
      resource: 'user',
      resourceId: user._id.toString(),
      details: `Created user: ${user.name} (${user.email}) with role: ${user.role}`,
    });

    res.status(201).json({
      success: true,
      data: {
        _id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        allowedPages: user.allowedPages,
      },
    });
  } catch (error) {
    console.error('Error creating user:', error);
    res.status(500).json({ success: false, error: 'Failed to create user' });
  }
});

// GET /api/admin/users/:id
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }

    res.json({
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
    res.status(500).json({ success: false, error: 'Failed to fetch user' });
  }
});

// PUT /api/admin/users/:id
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const currentUser = req.user!;
    if (currentUser.role !== 'super_admin') {
      res
        .status(403)
        .json({ success: false, error: 'Only super admins can update users' });
      return;
    }

    const targetUser = await User.findById(req.params.id).select('+password');
    if (!targetUser) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }

    if (
      targetUser.role === 'super_admin' &&
      currentUser.userId !== targetUser._id.toString()
    ) {
      res
        .status(403)
        .json({ success: false, error: 'Cannot modify another super admin' });
      return;
    }

    const { name, email, password, role, allowedPages } = req.body;
    if (name) targetUser.name = name;
    if (email) targetUser.email = email;
    if (password) targetUser.password = password;
    if (role) targetUser.role = role;
    if (allowedPages !== undefined) targetUser.allowedPages = allowedPages;

    await targetUser.save();

    await logActivity({
      userId: currentUser.userId,
      userName: currentUser.name,
      userEmail: currentUser.email,
      action: 'update',
      resource: 'user',
      resourceId: targetUser._id.toString(),
      details: `Updated user: ${targetUser.name} (${targetUser.email})`,
    });

    res.json({
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
    res.status(500).json({ success: false, error: 'Failed to update user' });
  }
});

// DELETE /api/admin/users/:id
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const currentUser = req.user!;
    if (currentUser.role !== 'super_admin') {
      res
        .status(403)
        .json({ success: false, error: 'Only super admins can delete users' });
      return;
    }

    if (currentUser.userId === req.params.id) {
      res
        .status(400)
        .json({ success: false, error: 'Cannot delete your own account' });
      return;
    }

    const targetUser = await User.findById(req.params.id);
    if (!targetUser) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }

    if (targetUser.role === 'super_admin') {
      res
        .status(403)
        .json({ success: false, error: 'Cannot delete a super admin' });
      return;
    }

    await User.findByIdAndDelete(req.params.id);

    await logActivity({
      userId: currentUser.userId,
      userName: currentUser.name,
      userEmail: currentUser.email,
      action: 'delete',
      resource: 'user',
      resourceId: req.params.id as string,
      details: `Deleted user: ${targetUser.name} (${targetUser.email})`,
    });

    res.json({ success: true, message: 'User deleted successfully' });
  } catch (error) {
    console.error('Error deleting user:', error);
    res.status(500).json({ success: false, error: 'Failed to delete user' });
  }
});

export default router;
