import { Router, Request, Response } from 'express';
import prisma from '../../db';
import { requireManufacturingInstance } from './middleware';

const router = Router();

// No trial tier — absence of an activated plan is just 'none' / inactive, same as the POS.
function daysRemaining(plan: string, expiry: string | null): number {
  if (plan === 'lifetime') return 9999;
  if (plan === 'monthly') {
    if (!expiry) return 0;
    return Math.max(0, Math.ceil((new Date(expiry).getTime() - Date.now()) / 86_400_000));
  }
  return 0;
}

/** GET /api/manufacturing/status — [auth: Bearer api_key] */
router.get('/status', requireManufacturingInstance, (req: Request, res: Response) => {
  const inst = req.mfgInstance!;
  const remaining = daysRemaining(inst.license_plan, inst.license_expiry);
  res.json({
    success: true,
    plan: inst.license_plan,
    active: inst.approval_status === 'approved' && remaining > 0,
    daysRemaining: remaining,
    expiry: inst.license_expiry,
    approval_status: inst.approval_status,
  });
});

/**
 * POST /api/manufacturing/activate — [auth: Bearer api_key]
 * Body: { license_key }
 *
 * License keys are issued by you (the vendor) for now — no self-serve
 * payment flow yet. Format: "MNTH-<days>" or "LIFE". Extend this with real
 * key generation/payment webhook once the website exists.
 */
router.post('/activate', requireManufacturingInstance, async (req: Request, res: Response) => {
  const { license_key } = req.body as Record<string, string>;
  const inst = req.mfgInstance!;
  if (!license_key) {
    res.status(400).json({ success: false, error: 'license_key is required' });
    return;
  }

  const [tag, daysStr] = license_key.trim().toUpperCase().split('-');
  if (tag === 'LIFE') {
    await prisma.manufacturingInstance.update({ where: { id: inst.id }, data: { license_plan: 'lifetime', license_expiry: null } });
    res.json({ success: true, plan: 'lifetime' });
    return;
  }
  if (tag === 'MNTH' && Number.isFinite(Number(daysStr))) {
    const days = Number(daysStr);
    const expiry = new Date(Date.now() + days * 86_400_000).toISOString();
    await prisma.manufacturingInstance.update({ where: { id: inst.id }, data: { license_plan: 'monthly', license_expiry: expiry } });
    res.json({ success: true, plan: 'monthly', expiry });
    return;
  }
  res.status(400).json({ success: false, error: 'Invalid license key' });
});

export default router;
