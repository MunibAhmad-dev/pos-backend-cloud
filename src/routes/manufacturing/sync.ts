import { Router, Request, Response } from 'express';
import prisma from '../../db';
import { requireManufacturingInstance } from './middleware';

const router = Router();

/**
 * POST /api/manufacturing/sync — [auth: Bearer api_key]
 * Body: { total_sales, total_revenue, total_products, total_parts, low_stock_items }
 *
 * Lightweight snapshot push (not a full transaction log like the POS's /api/sync) —
 * just enough for a future read-only website dashboard. Call this periodically
 * from the Electron app (e.g. on app start, or hourly) with getDashboardStats().
 */
router.post('/sync', requireManufacturingInstance, async (req: Request, res: Response) => {
  const inst = req.mfgInstance!;
  const { total_sales, total_revenue, total_products, total_parts, low_stock_items } = req.body as Record<string, number>;
  await prisma.manufacturingInstance.update({
    where: { id: inst.id },
    data: {
      total_sales: total_sales ?? undefined,
      total_revenue: total_revenue ?? undefined,
      total_products: total_products ?? undefined,
      total_parts: total_parts ?? undefined,
      low_stock_items: low_stock_items ?? undefined,
      last_seen: new Date(),
    },
  });
  res.json({ success: true });
});

export default router;
