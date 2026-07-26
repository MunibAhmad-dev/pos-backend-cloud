import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import bcrypt from 'bcryptjs';
import prisma from '../../db';

const router = Router();

/**
 * POST /api/manufacturing/register
 * Body: { mobile, password, company_name?, device_fingerprint?, app_version? }
 *
 * Creates a new installation record keyed by mobile number, or — if that
 * mobile is already registered — verifies the password and returns the
 * existing api_key (so reinstalling the app on the same phone number just
 * logs back in instead of erroring).
 */
router.post('/register', async (req: Request, res: Response) => {
  const { mobile, password, company_name, device_fingerprint, app_version } = req.body as Record<string, string>;
  if (!mobile || !password) {
    res.status(400).json({ success: false, error: 'mobile and password are required' });
    return;
  }

  const existing = await prisma.manufacturingInstance.findUnique({ where: { mobile: mobile.trim() } });
  if (existing) {
    const ok = await bcrypt.compare(password, existing.password_hash);
    if (!ok) {
      res.status(401).json({ success: false, error: 'This mobile number is already registered with a different password' });
      return;
    }
    const updated = await prisma.manufacturingInstance.update({
      where: { mobile: mobile.trim() },
      data: { device_fingerprint: device_fingerprint || undefined, app_version: app_version || undefined, last_seen: new Date() },
    });
    res.json({
      success: true, api_key: updated.api_key, approval_status: updated.approval_status,
      license_plan: updated.license_plan, license_expiry: updated.license_expiry,
      trial_start: updated.trial_start, message: 'Existing installation logged back in.',
    });
    return;
  }

  const password_hash = await bcrypt.hash(password, 10);
  const api_key = uuidv4();
  const created = await prisma.manufacturingInstance.create({
    data: {
      mobile: mobile.trim(), password_hash, company_name: company_name || '',
      api_key, device_fingerprint: device_fingerprint || '', app_version: app_version || '',
    },
  });

  res.status(201).json({
    success: true, api_key: created.api_key, approval_status: created.approval_status,
    license_plan: created.license_plan, license_expiry: created.license_expiry,
    trial_start: created.trial_start, message: 'Registered. 30-day trial started.',
  });
});

/**
 * POST /api/manufacturing/login
 * Body: { mobile, password }
 * Re-authenticates an already-registered installation (e.g. after a reinstall
 * or on a new device) and returns its api_key + current license status.
 */
router.post('/login', async (req: Request, res: Response) => {
  const { mobile, password } = req.body as Record<string, string>;
  if (!mobile || !password) {
    res.status(400).json({ success: false, error: 'mobile and password are required' });
    return;
  }
  const instance = await prisma.manufacturingInstance.findUnique({ where: { mobile: mobile.trim() } });
  if (!instance || !(await bcrypt.compare(password, instance.password_hash))) {
    res.status(401).json({ success: false, error: 'Invalid mobile number or password' });
    return;
  }
  await prisma.manufacturingInstance.update({ where: { mobile: mobile.trim() }, data: { last_seen: new Date() } });
  res.json({
    success: true, api_key: instance.api_key, approval_status: instance.approval_status,
    license_plan: instance.license_plan, license_expiry: instance.license_expiry, trial_start: instance.trial_start,
  });
});

export default router;
