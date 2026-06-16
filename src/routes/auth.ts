import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import prisma from '../db';
import { requireAdmin, signAdminToken, signMobileToken } from '../middleware/auth';
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
 * POST /api/auth/store-login   (PUBLIC — no auth)
 *
 * Store-owner login for the mobile app. Authenticates with the store's
 * instance_id + password (set by an admin in the admin panel) and returns a
 * long-lived mobile-scoped JWT the app uses for all /api/instances/* calls.
 */
router.post('/store-login', async (req: Request, res: Response) => {
  const { instance_id, password } = req.body as { instance_id?: string; password?: string };

  if (!instance_id || !password) {
    res.status(400).json({ success: false, error: 'instance_id and password are required' });
    return;
  }

  const instance = await prisma.instance.findUnique({
    where: { instance_id: instance_id.trim() },
  });

  // Generic message — don't reveal whether the ID exists or the password is set.
  if (!instance || !instance.password_hash) {
    res.status(401).json({ success: false, error: 'Invalid Store ID or password' });
    return;
  }

  const valid = await bcrypt.compare(password, instance.password_hash);
  if (!valid) {
    res.status(401).json({ success: false, error: 'Invalid Store ID or password' });
    return;
  }

  if (instance.approval_status === 'blocked') {
    const isLicenseRevoke = (instance.license_revoked ?? 0) === 1;
    res.status(403).json({
      success: false,
      error: isLicenseRevoke ? 'license_revoked' : 'blocked',
      message: instance.block_reason
        || (isLicenseRevoke
          ? 'Your license has been revoked. Contact OsaTech.'
          : 'This store has been blocked. Contact support.'),
    });
    return;
  }

  const storeName = instance.store_name || (instance as any).business_name || instance.instance_id;
  const token = signMobileToken({
    instance_id:  instance.instance_id,
    store_name:   storeName,
    owner_mobile: instance.owner_mobile || '',
    scope:        'mobile',
  });

  res.json({
    success:         true,
    token,
    instance_id:     instance.instance_id,
    store_name:      storeName,
    approval_status: instance.approval_status,
    license_plan:    instance.license_plan || null,
    license_expiry:  instance.license_expiry || null,
  });
});

/**
 * GET /api/auth/me
 */
router.get('/me', requireAdmin, (req: Request, res: Response) => {
  res.json({ success: true, admin: req.admin });
});

export default router;
