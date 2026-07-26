import { Router, Request, Response } from 'express';
import prisma from '../../db';
import { requireManufacturingInstance } from './middleware';

const router = Router();

// The generic Notification model already exists for the POS (target_instance_id
// has no FK, so it's safe to reuse) — manufacturing installs are addressed with
// the "mfg:<mobile>" prefix so the two apps' notifications never collide.

/** GET /api/manufacturing/notifications — [auth: Bearer api_key] */
router.get('/notifications', requireManufacturingInstance, async (req: Request, res: Response) => {
  const inst = req.mfgInstance!;
  const now = new Date();
  const notifications = await prisma.notification.findMany({
    where: {
      is_active: true,
      OR: [{ target_instance_id: null }, { target_instance_id: `mfg:${inst.mobile}` }],
    },
    orderBy: { sent_at: 'desc' },
  });
  const visible = notifications.filter(n => !n.expires_at || n.expires_at > now);
  res.json({ success: true, notifications: visible });
});

export default router;
