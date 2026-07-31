import { Router, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import prisma from '../../db';
import { requireManufacturingInstance } from './middleware';

const router = Router();

function parseRows(rows: Array<{ payload: string }>): any[] {
  return rows
    .map(r => { try { return JSON.parse(r.payload as any); } catch { return null; } })
    .filter(Boolean);
}

function computeProduct(p: any, partsStockMap: Map<string, number>) {
  const components: any[] = Array.isArray(p.components) ? p.components : [];

  const materialCost = components.reduce(
    (sum: number, c: any) => sum + Number(c.quantity || 0) * Number(c.unit_cost || 0), 0
  );
  const laborCost     = Number(p.labor_cost     || 0);
  const transportCost = Number(p.transport_cost || 0);
  const costPerUnit   = materialCost + laborCost + transportCost;

  const liveBuildable = components.length === 0
    ? 0
    : Math.floor(Math.min(
        ...components.map((c: any) => {
          const qty = Number(c.quantity || 0);
          if (qty <= 0) return Infinity;
          return (partsStockMap.get(String(c.part_id)) ?? 0) / qty;
        })
      ) || 0);

  const allocatedUnits = p.allocated_units ?? null;
  const availableToSell = allocatedUnits != null
    ? Math.min(liveBuildable, allocatedUnits)
    : liveBuildable;
  const moreBuildable = Math.max(0, liveBuildable - availableToSell);

  return {
    id:                p.id,
    name:              p.name || '',
    description:       p.description || '',
    category:          p.category || '',
    labor_cost:        laborCost,
    transport_cost:    transportCost,
    profit_margin_pct: Number(p.profit_margin_pct || 0),
    selling_price:     Number(p.selling_price || 0),
    stock:             Number(p.stock || 0),
    allocated_units:   allocatedUnits,
    components,
    material_cost:     materialCost,
    cost_per_unit:     costPerUnit,
    available_to_sell: availableToSell,
    live_buildable:    liveBuildable,
    more_buildable:    moreBuildable,
  };
}

/**
 * GET /api/manufacturing/products
 * Returns all product models with computed BOM costs and buildable counts.
 */
router.get('/products', requireManufacturingInstance, async (req: Request, res: Response) => {
  const inst   = req.mfgInstance!;
  const search = ((req.query.search as string) || '').trim().toLowerCase();

  try {
    const [productRows, partRows] = await Promise.all([
      prisma.$queryRaw<Array<{ payload: string }>>(Prisma.sql`
        WITH latest AS (
          SELECT payload, operation,
            ROW_NUMBER() OVER (PARTITION BY local_id ORDER BY id DESC) AS rn
          FROM manufacturing_sync_events
          WHERE instance_id = ${inst.id} AND entity_type = 'product'
        )
        SELECT payload FROM latest WHERE rn = 1 AND operation != 'delete'
      `),
      prisma.$queryRaw<Array<{ payload: string }>>(Prisma.sql`
        WITH latest AS (
          SELECT payload, operation,
            ROW_NUMBER() OVER (PARTITION BY local_id ORDER BY id DESC) AS rn
          FROM manufacturing_sync_events
          WHERE instance_id = ${inst.id} AND entity_type = 'part'
        )
        SELECT payload FROM latest WHERE rn = 1 AND operation != 'delete'
      `),
    ]);

    const partsStockMap = new Map<string, number>();
    for (const p of parseRows(partRows)) {
      partsStockMap.set(String(p.id), Number(p.stock ?? 0));
    }

    let products = parseRows(productRows).map(p => computeProduct(p, partsStockMap));

    if (search) {
      products = products.filter(p =>
        p.name.toLowerCase().includes(search) ||
        p.description.toLowerCase().includes(search)
      );
    }

    res.json({ success: true, products });
  } catch (err: any) {
    console.error('[manufacturing/products] GET:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/manufacturing/products
 * Creates a product model. Components (BOM) are embedded in the payload so the
 * cloud stores the full recipe — the Electron desktop app only syncs the scalar
 * product row and does not receive component data from the cloud.
 *
 * Body: { name, description, category, labor_cost, transport_cost,
 *         profit_margin_pct, selling_price, stock, allocated_units,
 *         components: [{ part_id, part_name, quantity, unit_cost, unit }] }
 */
router.post('/products', requireManufacturingInstance, async (req: Request, res: Response) => {
  const inst = req.mfgInstance!;
  const {
    name, description, category,
    labor_cost, transport_cost, profit_margin_pct, selling_price,
    stock, allocated_units, components,
  } = req.body;

  if (!name?.trim()) {
    res.status(400).json({ success: false, error: 'Product name is required' });
    return;
  }

  try {
    const id = Math.floor(Date.now() / 1000);
    const payload = {
      id,
      name:              name.trim(),
      description:       (description || '').trim(),
      category:          (category || '').trim(),
      labor_cost:        Number(labor_cost     || 0),
      transport_cost:    Number(transport_cost || 0),
      profit_margin_pct: Number(profit_margin_pct || 0),
      selling_price:     Number(selling_price  || 0),
      stock:             Number(stock          || 0),
      allocated_units:   allocated_units != null ? Number(allocated_units) : null,
      components:        Array.isArray(components) ? components : [],
      created_at:        new Date().toISOString(),
    };

    await prisma.manufacturingSyncEvent.create({
      data: {
        instance_id: inst.id,
        entity_type: 'product',
        operation:   'create',
        local_id:    id,
        payload:     JSON.stringify(payload),
      },
    });

    res.status(201).json({ success: true, product: payload });
  } catch (err: any) {
    console.error('[manufacturing/products] POST:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * PUT /api/manufacturing/products/:id
 * Full update — replaces the product payload including components.
 */
router.put('/products/:id', requireManufacturingInstance, async (req: Request, res: Response) => {
  const inst    = req.mfgInstance!;
  const localId = Number(req.params.id);
  const {
    name, description, category,
    labor_cost, transport_cost, profit_margin_pct, selling_price,
    stock, allocated_units, components,
  } = req.body;

  if (!name?.trim()) {
    res.status(400).json({ success: false, error: 'Product name is required' });
    return;
  }

  try {
    const payload = {
      id:                localId,
      name:              name.trim(),
      description:       (description || '').trim(),
      category:          (category || '').trim(),
      labor_cost:        Number(labor_cost     || 0),
      transport_cost:    Number(transport_cost || 0),
      profit_margin_pct: Number(profit_margin_pct || 0),
      selling_price:     Number(selling_price  || 0),
      stock:             Number(stock          || 0),
      allocated_units:   allocated_units != null ? Number(allocated_units) : null,
      components:        Array.isArray(components) ? components : [],
      updated_at:        new Date().toISOString(),
    };

    await prisma.manufacturingSyncEvent.create({
      data: {
        instance_id: inst.id,
        entity_type: 'product',
        operation:   'update',
        local_id:    localId,
        payload:     JSON.stringify(payload),
      },
    });

    res.json({ success: true, product: payload });
  } catch (err: any) {
    console.error('[manufacturing/products] PUT:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * DELETE /api/manufacturing/products/:id
 * Soft-delete via sync event.
 */
router.delete('/products/:id', requireManufacturingInstance, async (req: Request, res: Response) => {
  const inst    = req.mfgInstance!;
  const localId = Number(req.params.id);

  try {
    await prisma.manufacturingSyncEvent.create({
      data: {
        instance_id: inst.id,
        entity_type: 'product',
        operation:   'delete',
        local_id:    localId,
        payload:     JSON.stringify({ id: localId }),
      },
    });

    res.json({ success: true });
  } catch (err: any) {
    console.error('[manufacturing/products] DELETE:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
