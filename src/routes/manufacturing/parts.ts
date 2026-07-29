import { Router, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import prisma from '../../db';
import { requireManufacturingInstance } from './middleware';

const router = Router();

// ─── helpers ────────────────────────────────────────────────────────────────────

function parseRows(rows: Array<{ payload: string }>): any[] {
  return rows
    .map(r => { try { return JSON.parse(r.payload as any); } catch { return null; } })
    .filter(Boolean);
}

/**
 * GET /api/manufacturing/parts
 * Returns the latest state for every part (last-write-wins CTE).
 * Also computes sold_loose from sale sync events.
 * Query: ?search=
 */
router.get('/parts', requireManufacturingInstance, async (req: Request, res: Response) => {
  const inst   = req.mfgInstance!;
  const search = ((req.query.search as string) || '').trim().toLowerCase();

  try {
    // ── Latest state per part ──
    const partRows = await prisma.$queryRaw<Array<{ payload: string }>>(Prisma.sql`
      WITH latest AS (
        SELECT payload, operation,
          ROW_NUMBER() OVER (PARTITION BY local_id ORDER BY id DESC) AS rn
        FROM manufacturing_sync_events
        WHERE instance_id = ${inst.id} AND entity_type = 'part'
      )
      SELECT payload FROM latest WHERE rn = 1 AND operation != 'delete'
    `);

    let parts: any[] = parseRows(partRows).map(p => ({
      id:                  p.id,
      name:                p.name || '',
      category:            p.category || '',
      unit:                p.unit || 'pc',
      cost_price:          Number(p.cost_price  ?? 0),
      selling_price:       Number(p.selling_price ?? p.price ?? 0),
      stock:               Number(p.stock         ?? 0),
      low_stock_threshold: Number(p.low_stock_threshold ?? 5),
    }));

    if (search) {
      parts = parts.filter(p =>
        p.name.toLowerCase().includes(search) ||
        p.category.toLowerCase().includes(search)
      );
    }

    // ── sold_loose per part from sale events ──
    const saleRows = await prisma.$queryRaw<Array<{ payload: string }>>(Prisma.sql`
      WITH latest AS (
        SELECT payload, operation,
          ROW_NUMBER() OVER (PARTITION BY local_id ORDER BY id DESC) AS rn
        FROM manufacturing_sync_events
        WHERE instance_id = ${inst.id} AND entity_type = 'sale'
      )
      SELECT payload FROM latest WHERE rn = 1 AND operation != 'delete'
    `);

    const soldLooseMap = new Map<string, number>();
    for (const s of parseRows(saleRows)) {
      for (const item of (s.items || [])) {
        if (item.type === 'parts' || item.type === 'part') {
          const key = String(item.id);
          soldLooseMap.set(key, (soldLooseMap.get(key) || 0) + Number(item.qty || 0));
        }
      }
    }

    const result = parts.map(p => ({
      ...p,
      sold_loose:      soldLooseMap.get(String(p.id)) || 0,
      used_in_coolers: 0, // requires product assembly BOM — not yet in sync events
      value:           p.stock * p.cost_price,
    }));

    const lowStockCount = result.filter(p => p.stock <= p.low_stock_threshold).length;

    res.json({ success: true, parts: result, low_stock_count: lowStockCount });
  } catch (err: any) {
    console.error('[manufacturing/parts] GET:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/manufacturing/parts
 * Creates a new part by pushing a 'create' sync event.
 * Body: { name, category, unit, cost_price, selling_price, stock, low_stock_threshold }
 */
router.post('/parts', requireManufacturingInstance, async (req: Request, res: Response) => {
  const inst = req.mfgInstance!;
  const { name, category, unit, cost_price, selling_price, stock, low_stock_threshold } = req.body;

  if (!name?.trim()) {
    res.status(400).json({ success: false, error: 'Part name is required' });
    return;
  }

  try {
    const id      = Date.now();
    const payload = {
      id,
      name:                name.trim(),
      category:            (category || '').trim(),
      unit:                unit || 'pc',
      cost_price:          Number(cost_price    || 0),
      selling_price:       Number(selling_price || 0),
      stock:               Number(stock         || 0),
      low_stock_threshold: Number(low_stock_threshold || 5),
      created_at:          new Date().toISOString(),
    };

    await prisma.manufacturingSyncEvent.create({
      data: {
        instance_id: inst.id,
        entity_type: 'part',
        operation:   'create',
        local_id:    id,
        payload:     JSON.stringify(payload),
      },
    });

    res.status(201).json({
      success: true,
      part: {
        ...payload,
        sold_loose:      0,
        used_in_coolers: 0,
        value:           payload.stock * payload.cost_price,
      },
    });
  } catch (err: any) {
    console.error('[manufacturing/parts] POST:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * PUT /api/manufacturing/parts/:id
 * Updates all fields of an existing part.
 * Body: { name, category, unit, cost_price, selling_price, stock, low_stock_threshold }
 */
router.put('/parts/:id', requireManufacturingInstance, async (req: Request, res: Response) => {
  const inst    = req.mfgInstance!;
  const localId = Number(req.params.id);
  const { name, category, unit, cost_price, selling_price, stock, low_stock_threshold } = req.body;

  if (!name?.trim()) {
    res.status(400).json({ success: false, error: 'Part name is required' });
    return;
  }

  try {
    const payload = {
      id:                  localId,
      name:                name.trim(),
      category:            (category || '').trim(),
      unit:                unit || 'pc',
      cost_price:          Number(cost_price    || 0),
      selling_price:       Number(selling_price || 0),
      stock:               Number(stock         || 0),
      low_stock_threshold: Number(low_stock_threshold || 5),
      updated_at:          new Date().toISOString(),
    };

    await prisma.manufacturingSyncEvent.create({
      data: {
        instance_id: inst.id,
        entity_type: 'part',
        operation:   'update',
        local_id:    localId,
        payload:     JSON.stringify(payload),
      },
    });

    res.json({
      success: true,
      part: { ...payload, value: payload.stock * payload.cost_price },
    });
  } catch (err: any) {
    console.error('[manufacturing/parts] PUT:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * PATCH /api/manufacturing/parts/:id/stock
 * Quick stock adjustment — preserves all other fields.
 * Body: { stock }
 */
router.patch('/parts/:id/stock', requireManufacturingInstance, async (req: Request, res: Response) => {
  const inst    = req.mfgInstance!;
  const localId = Number(req.params.id);
  const newStock = Number(req.body.stock);

  if (isNaN(newStock) || newStock < 0) {
    res.status(400).json({ success: false, error: 'Valid stock value is required' });
    return;
  }

  try {
    // Fetch current payload to preserve all non-stock fields
    const [latest] = await prisma.$queryRaw<Array<{ payload: string }>>(Prisma.sql`
      WITH latest AS (
        SELECT payload, operation,
          ROW_NUMBER() OVER (PARTITION BY local_id ORDER BY id DESC) AS rn
        FROM manufacturing_sync_events
        WHERE instance_id = ${inst.id} AND entity_type = 'part' AND local_id = ${localId}
      )
      SELECT payload FROM latest WHERE rn = 1 AND operation != 'delete'
    `);

    if (!latest) {
      res.status(404).json({ success: false, error: 'Part not found' });
      return;
    }

    const current = JSON.parse(latest.payload as any);
    const payload = { ...current, stock: newStock, updated_at: new Date().toISOString() };

    await prisma.manufacturingSyncEvent.create({
      data: {
        instance_id: inst.id,
        entity_type: 'part',
        operation:   'update',
        local_id:    localId,
        payload:     JSON.stringify(payload),
      },
    });

    res.json({ success: true, part: { ...payload, value: newStock * (current.cost_price || 0) } });
  } catch (err: any) {
    console.error('[manufacturing/parts] PATCH stock:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * DELETE /api/manufacturing/parts/:id
 * Soft-delete: pushes a 'delete' sync event so the desktop can honour it.
 */
router.delete('/parts/:id', requireManufacturingInstance, async (req: Request, res: Response) => {
  const inst    = req.mfgInstance!;
  const localId = Number(req.params.id);

  try {
    await prisma.manufacturingSyncEvent.create({
      data: {
        instance_id: inst.id,
        entity_type: 'part',
        operation:   'delete',
        local_id:    localId,
        payload:     JSON.stringify({ id: localId }),
      },
    });

    res.json({ success: true });
  } catch (err: any) {
    console.error('[manufacturing/parts] DELETE:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
