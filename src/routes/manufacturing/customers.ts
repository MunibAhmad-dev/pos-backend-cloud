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

function normaliseCustomer(p: any) {
  return {
    id:         p.id,
    name:       p.name    || '',
    phone:      p.phone   || '',
    whatsapp:   p.whatsapp || '',
    address:    p.address  || '',
    city:       p.city     || '',
    notes:      p.notes    || '',
    created_at: p.created_at || null,
  };
}

/** GET /api/manufacturing/customers */
router.get('/customers', requireManufacturingInstance, async (req: Request, res: Response) => {
  const inst   = req.mfgInstance!;
  const search = ((req.query.search as string) || '').trim().toLowerCase();
  try {
    const rows = await prisma.$queryRaw<Array<{ payload: string }>>(Prisma.sql`
      WITH latest AS (
        SELECT payload, operation,
          ROW_NUMBER() OVER (PARTITION BY local_id ORDER BY id DESC) AS rn
        FROM manufacturing_sync_events
        WHERE instance_id = ${inst.id} AND entity_type = 'customer'
      )
      SELECT payload FROM latest WHERE rn = 1 AND operation != 'delete'
    `);

    let customers = parseRows(rows).map(normaliseCustomer);
    if (search) {
      customers = customers.filter(c =>
        c.name.toLowerCase().includes(search) ||
        c.phone.includes(search) ||
        c.city.toLowerCase().includes(search)
      );
    }
    customers.sort((a, b) => a.name.localeCompare(b.name));
    res.json({ success: true, customers });
  } catch (err: any) {
    console.error('[mfg/customers] GET:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/** GET /api/manufacturing/customers/:id/profile */
router.get('/customers/:id/profile', requireManufacturingInstance, async (req: Request, res: Response) => {
  const inst    = req.mfgInstance!;
  const localId = Number(req.params.id);
  try {
    // ── customer ──
    const [custRow] = await prisma.$queryRaw<Array<{ payload: string }>>(Prisma.sql`
      WITH latest AS (
        SELECT payload, operation,
          ROW_NUMBER() OVER (PARTITION BY local_id ORDER BY id DESC) AS rn
        FROM manufacturing_sync_events
        WHERE instance_id = ${inst.id} AND entity_type = 'customer' AND local_id = ${localId}
      )
      SELECT payload FROM latest WHERE rn = 1 AND operation != 'delete'
    `);
    if (!custRow) { res.status(404).json({ success: false, error: 'Customer not found' }); return; }
    const customer = normaliseCustomer(JSON.parse(custRow.payload as any));

    // ── sales for this customer ──
    const saleRows = await prisma.$queryRaw<Array<{ payload: string }>>(Prisma.sql`
      WITH latest AS (
        SELECT payload, operation,
          ROW_NUMBER() OVER (PARTITION BY local_id ORDER BY id DESC) AS rn
        FROM manufacturing_sync_events
        WHERE instance_id = ${inst.id} AND entity_type = 'sale'
      )
      SELECT payload FROM latest WHERE rn = 1 AND operation != 'delete'
    `);

    const sales = parseRows(saleRows).filter(s =>
      String(s.customer_id) === String(localId) ||
      (s.customer_name || '').toLowerCase() === customer.name.toLowerCase()
    );

    const totalOrders    = sales.length;
    const lifetimeValue  = sales.reduce((s, p) => s + Number(p.total      || 0), 0);
    const totalPaid      = sales.reduce((s, p) => s + Number(p.paid_amount || 0), 0);
    const dueAmount      = Math.max(0, lifetimeValue - totalPaid);

    const recent = sales
      .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
      .slice(0, 20)
      .map(s => ({
        id:             s.id,
        total:          Number(s.total      || 0),
        paid_amount:    Number(s.paid_amount || 0),
        status:         s.status || '',
        payment_method: s.payment_method || '',
        created_at:     s.created_at || null,
        items_count:    Number(s.items_count || 0),
      }));

    res.json({ success: true, customer, analytics: { totalOrders, lifetimeValue, totalPaid, dueAmount }, sales: recent });
  } catch (err: any) {
    console.error('[mfg/customers] profile:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/** POST /api/manufacturing/customers */
router.post('/customers', requireManufacturingInstance, async (req: Request, res: Response) => {
  const inst = req.mfgInstance!;
  const { name, phone, whatsapp, address, city, notes } = req.body;
  if (!name?.trim()) { res.status(400).json({ success: false, error: 'Customer name is required' }); return; }
  try {
    const id = Date.now();
    const payload = {
      id, name: name.trim(),
      phone:    (phone    || '').trim(),
      whatsapp: (whatsapp || '').trim(),
      address:  (address  || '').trim(),
      city:     (city     || '').trim(),
      notes:    (notes    || '').trim(),
      created_at: new Date().toISOString(),
    };
    await prisma.manufacturingSyncEvent.create({
      data: { instance_id: inst.id, entity_type: 'customer', operation: 'create', local_id: id, payload: JSON.stringify(payload) },
    });
    res.status(201).json({ success: true, customer: normaliseCustomer(payload) });
  } catch (err: any) {
    console.error('[mfg/customers] POST:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/** PUT /api/manufacturing/customers/:id */
router.put('/customers/:id', requireManufacturingInstance, async (req: Request, res: Response) => {
  const inst    = req.mfgInstance!;
  const localId = Number(req.params.id);
  const { name, phone, whatsapp, address, city, notes } = req.body;
  if (!name?.trim()) { res.status(400).json({ success: false, error: 'Customer name is required' }); return; }
  try {
    const payload = {
      id: localId, name: name.trim(),
      phone:    (phone    || '').trim(),
      whatsapp: (whatsapp || '').trim(),
      address:  (address  || '').trim(),
      city:     (city     || '').trim(),
      notes:    (notes    || '').trim(),
      updated_at: new Date().toISOString(),
    };
    await prisma.manufacturingSyncEvent.create({
      data: { instance_id: inst.id, entity_type: 'customer', operation: 'update', local_id: localId, payload: JSON.stringify(payload) },
    });
    res.json({ success: true, customer: normaliseCustomer(payload) });
  } catch (err: any) {
    console.error('[mfg/customers] PUT:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/** DELETE /api/manufacturing/customers/:id */
router.delete('/customers/:id', requireManufacturingInstance, async (req: Request, res: Response) => {
  const inst    = req.mfgInstance!;
  const localId = Number(req.params.id);
  try {
    await prisma.manufacturingSyncEvent.create({
      data: { instance_id: inst.id, entity_type: 'customer', operation: 'delete', local_id: localId, payload: JSON.stringify({ id: localId }) },
    });
    res.json({ success: true });
  } catch (err: any) {
    console.error('[mfg/customers] DELETE:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
