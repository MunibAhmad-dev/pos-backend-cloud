/**
 * /api/admin/payments — admin payment records (admin-only, stored in DB)
 */
import { Router, Request, Response } from 'express';
import prisma from '../db';
import { requireAdmin } from '../middleware/auth';

const router = Router();
router.use(requireAdmin);

/** GET /api/admin/payments?month=YYYY-MM */
router.get('/', async (req: Request, res: Response) => {
  const { month } = req.query as { month?: string };
  const where = month ? { month } : {};
  const records = await prisma.adminPaymentRecord.findMany({
    where,
    orderBy: { date: 'desc' },
  });
  res.json({ success: true, data: records });
});

/** POST /api/admin/payments */
router.post('/', async (req: Request, res: Response) => {
  const { instance_id, store_name, amount, month, date, notes } = req.body as {
    instance_id: string; store_name: string; amount: number;
    month: string; date: string; notes?: string;
  };
  if (!instance_id || !store_name || !amount || !month || !date) {
    res.status(400).json({ success: false, error: 'Missing required fields' });
    return;
  }
  const record = await prisma.adminPaymentRecord.create({
    data: {
      instance_id,
      store_name,
      amount: Number(amount),
      month,
      date: new Date(date),
      notes: notes || '',
      recorded_by: req.admin?.username || '',
    },
  });
  res.status(201).json({ success: true, data: record });
});

/** PUT /api/admin/payments/:id */
router.put('/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  const { instance_id, store_name, amount, month, date, notes } = req.body as {
    instance_id?: string; store_name?: string; amount?: number;
    month?: string; date?: string; notes?: string;
  };
  const existing = await prisma.adminPaymentRecord.findUnique({ where: { id } });
  if (!existing) { res.status(404).json({ success: false, error: 'Not found' }); return; }

  const record = await prisma.adminPaymentRecord.update({
    where: { id },
    data: {
      ...(instance_id !== undefined && { instance_id }),
      ...(store_name  !== undefined && { store_name }),
      ...(amount      !== undefined && { amount: Number(amount) }),
      ...(month       !== undefined && { month }),
      ...(date        !== undefined && { date: new Date(date) }),
      ...(notes       !== undefined && { notes }),
    },
  });
  res.json({ success: true, data: record });
});

/** DELETE /api/admin/payments/:id */
router.delete('/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  const existing = await prisma.adminPaymentRecord.findUnique({ where: { id } });
  if (!existing) { res.status(404).json({ success: false, error: 'Not found' }); return; }
  await prisma.adminPaymentRecord.delete({ where: { id } });
  res.json({ success: true });
});

export default router;
