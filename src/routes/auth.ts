import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import prisma from '../db';
import { requireAdmin, signAdminToken } from '../middleware/auth';
import '../types'; // loads Express Request augmentation (req.admin, req.instance)

const router = Router();

/**
 * POST /api/auth/setup
 * Creates the very first admin account. Protected by the ADMIN_SETUP_KEY
 * environment variable so it can't be called again once an admin exists.
 */
router.post('/setup', async (req: Request, res: Response) => {
  const setupKey  = req.headers['x-setup-key'];
  const expected  = process.env.ADMIN_SETUP_KEY || 'setup_osatech_2025';

  if (setupKey !== expected) {
    res.status(403).json({ success: false, error: 'Invalid setup key' });
    return;
  }

  const existing = await prisma.adminUser.findFirst();
  if (existing) {
    res.status(409).json({ success: false, error: 'Admin already exists. Use /login instead.' });
    return;
  }

  const { username, password } = req.body as { username?: string; password?: string };
  if (!username || !password) {
    res.status(400).json({ success: false, error: 'username and password are required' });
    return;
  }
  if (password.length < 6) {
    res.status(400).json({ success: false, error: 'Password must be at least 6 characters' });
    return;
  }

  const hash  = await bcrypt.hash(password, 12);
  const admin = await prisma.adminUser.create({
    data: { username: username.trim().toLowerCase(), password_hash: hash, role: 'super_admin' },
  });

  const token = signAdminToken({ id: admin.id, username: admin.username, role: admin.role });
  res.status(201).json({ success: true, message: 'Admin created', token });
});

/**
 * POST /api/auth/login
 */
router.post('/login', async (req: Request, res: Response) => {
  const { username, password } = req.body as { username?: string; password?: string };
  if (!username || !password) {
    res.status(400).json({ success: false, error: 'username and password are required' });
    return;
  }

  const admin = await prisma.adminUser.findUnique({
    where: { username: username.trim().toLowerCase() },
  });

  if (!admin) {
    res.status(401).json({ success: false, error: 'Invalid credentials' });
    return;
  }

  const valid = await bcrypt.compare(password, admin.password_hash);
  if (!valid) {
    res.status(401).json({ success: false, error: 'Invalid credentials' });
    return;
  }

  const payload   = { id: admin.id, username: admin.username, role: admin.role };
  const token     = signAdminToken(payload);
  const expiresIn = process.env.JWT_EXPIRES_IN || '7d';

  res.json({ success: true, token, expiresIn, admin: payload });
});

/**
 * GET /api/auth/me
 */
router.get('/me', requireAdmin, (req: Request, res: Response) => {
  res.json({ success: true, admin: req.admin });
});

export default router;
