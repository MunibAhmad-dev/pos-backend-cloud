import { Router, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import prisma from '../../db';
import { requireManufacturingInstance } from './middleware';

const router = Router();

/**
 * GET /api/manufacturing/sell-items — [auth: Bearer api_key]
 *
 * Returns the latest synced products and parts for the sell/POS page.
 * Uses last-write-wins CTE per local_id, excludes deletes.
 *
 * Query params:
 *   search — optional text filter (applied server-side on name/category)
 */
router.get('/sell-items', requireManufacturingInstance, async (req: Request, res: Response) => {
  const inst = req.mfgInstance!;
  const search = ((req.query.search as string) || '').trim().toLowerCase();

  try {
    const productRows = await prisma.$queryRaw<Array<{ payload: string }>>(Prisma.sql`
      WITH latest AS (
        SELECT payload, operation,
          ROW_NUMBER() OVER (PARTITION BY local_id ORDER BY id DESC) AS rn
        FROM manufacturing_sync_events
        WHERE instance_id = ${inst.id} AND entity_type = 'product'
      )
      SELECT payload FROM latest WHERE rn = 1 AND operation != 'delete'
    `);

    const partRows = await prisma.$queryRaw<Array<{ payload: string }>>(Prisma.sql`
      WITH latest AS (
        SELECT payload, operation,
          ROW_NUMBER() OVER (PARTITION BY local_id ORDER BY id DESC) AS rn
        FROM manufacturing_sync_events
        WHERE instance_id = ${inst.id} AND entity_type = 'part'
      )
      SELECT payload FROM latest WHERE rn = 1 AND operation != 'delete'
    `);

    const parse = (rows: Array<{ payload: string }>) =>
      rows.map(r => { try { return JSON.parse(r.payload as any); } catch { return null; } }).filter(Boolean);

    const LOW = 5;
    let products = parse(productRows).map((p: any) => ({
      id:                  p.id,
      name:                p.name    || '',
      category:            p.category || '',
      stock:               Number(p.stock            ?? 0),
      price:               Number(p.price            ?? 0),
      purchase_price:      Number(p.purchase_price   ?? 0),
      low_stock_threshold: Number(p.low_stock_threshold ?? LOW),
      unit:                p.unit || 'pc',
    }));

    let parts = parse(partRows).map((p: any) => ({
      id:                  p.id,
      name:                p.name    || '',
      category:            p.category || '',
      stock:               Number(p.stock      ?? 0),
      cost_price:          Number(p.cost_price ?? p.price ?? 0),
      low_stock_threshold: Number(p.low_stock_threshold ?? LOW),
      unit:                p.unit || 'pc',
    }));

    if (search) {
      const matches = (s: string) => s.toLowerCase().includes(search);
      products = products.filter((p: any) => matches(p.name) || matches(p.category));
      parts    = parts.filter((p: any)    => matches(p.name) || matches(p.category));
    }

    res.json({ success: true, products, parts });
  } catch (err: any) {
    console.error('[manufacturing/sell-items]', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
