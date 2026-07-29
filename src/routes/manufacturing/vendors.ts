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

function normaliseVendor(p: any) {
  return {
    id:           p.id,
    name:         p.name || '',
    company_name: p.company_name || '',
    phone:        p.phone   || '',
    whatsapp:     p.whatsapp || '',
    address:      p.address  || '',
    email:        p.email    || '',
    ntn:          p.ntn      || '',
    notes:        p.notes    || '',
    created_at:   p.created_at || null,
  };
}

/** GET /api/manufacturing/vendors */
router.get('/vendors', requireManufacturingInstance, async (req: Request, res: Response) => {
  const inst   = req.mfgInstance!;
  const search = ((req.query.search as string) || '').trim().toLowerCase();
  try {
    const rows = await prisma.$queryRaw<Array<{ payload: string }>>(Prisma.sql`
      WITH latest AS (
        SELECT payload, operation,
          ROW_NUMBER() OVER (PARTITION BY local_id ORDER BY id DESC) AS rn
        FROM manufacturing_sync_events
        WHERE instance_id = ${inst.id} AND entity_type = 'vendor'
      )
      SELECT payload FROM latest WHERE rn = 1 AND operation != 'delete'
    `);

    let vendors = parseRows(rows).map(normaliseVendor);
    if (search) {
      vendors = vendors.filter(v =>
        v.name.toLowerCase().includes(search) ||
        v.company_name.toLowerCase().includes(search) ||
        v.phone.includes(search)
      );
    }
    vendors.sort((a, b) => a.name.localeCompare(b.name));
    res.json({ success: true, vendors });
  } catch (err: any) {
    console.error('[mfg/vendors] GET:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/** GET /api/manufacturing/vendors/:id/profile */
router.get('/vendors/:id/profile', requireManufacturingInstance, async (req: Request, res: Response) => {
  const inst    = req.mfgInstance!;
  const localId = Number(req.params.id);
  try {
    // ── vendor ──
    const [vendorRow] = await prisma.$queryRaw<Array<{ payload: string }>>(Prisma.sql`
      WITH latest AS (
        SELECT payload, operation,
          ROW_NUMBER() OVER (PARTITION BY local_id ORDER BY id DESC) AS rn
        FROM manufacturing_sync_events
        WHERE instance_id = ${inst.id} AND entity_type = 'vendor' AND local_id = ${localId}
      )
      SELECT payload FROM latest WHERE rn = 1 AND operation != 'delete'
    `);
    if (!vendorRow) { res.status(404).json({ success: false, error: 'Vendor not found' }); return; }
    const vendor = normaliseVendor(JSON.parse(vendorRow.payload as any));

    // ── purchases for this vendor ──
    const purchaseRows = await prisma.$queryRaw<Array<{ payload: string }>>(Prisma.sql`
      WITH latest AS (
        SELECT payload, operation,
          ROW_NUMBER() OVER (PARTITION BY local_id ORDER BY id DESC) AS rn
        FROM manufacturing_sync_events
        WHERE instance_id = ${inst.id} AND entity_type = 'purchase'
      )
      SELECT payload FROM latest WHERE rn = 1 AND operation != 'delete'
    `);

    const purchases = parseRows(purchaseRows).filter(p =>
      String(p.vendor_id) === String(localId) ||
      (p.vendor_name || '').toLowerCase() === vendor.name.toLowerCase()
    );

    const totalOrders      = purchases.length;
    const totalPurchased   = purchases.reduce((s, p) => s + Number(p.total || 0), 0);
    const totalPaid        = purchases.reduce((s, p) => s + Number(p.paid_amount || 0), 0);
    const outstanding      = Math.max(0, totalPurchased - totalPaid);

    const recent = purchases
      .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
      .slice(0, 20)
      .map(p => ({
        id:             p.id,
        total:          Number(p.total     || 0),
        paid_amount:    Number(p.paid_amount || 0),
        status:         p.status || '',
        payment_method: p.payment_method || '',
        created_at:     p.created_at || null,
        items_count:    Number(p.items_count || 0),
        invoice_number: p.invoice_number || '',
      }));

    res.json({ success: true, vendor, analytics: { totalOrders, totalPurchased, totalPaid, outstanding }, purchases: recent });
  } catch (err: any) {
    console.error('[mfg/vendors] profile:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/** POST /api/manufacturing/vendors */
router.post('/vendors', requireManufacturingInstance, async (req: Request, res: Response) => {
  const inst = req.mfgInstance!;
  const { name, company_name, phone, whatsapp, address, email, ntn, notes } = req.body;
  if (!name?.trim()) { res.status(400).json({ success: false, error: 'Vendor name is required' }); return; }
  try {
    const id = Date.now();
    const payload = {
      id, name: name.trim(),
      company_name: (company_name || '').trim(),
      phone:    (phone    || '').trim(),
      whatsapp: (whatsapp || '').trim(),
      address:  (address  || '').trim(),
      email:    (email    || '').trim(),
      ntn:      (ntn      || '').trim(),
      notes:    (notes    || '').trim(),
      created_at: new Date().toISOString(),
    };
    await prisma.manufacturingSyncEvent.create({
      data: { instance_id: inst.id, entity_type: 'vendor', operation: 'create', local_id: id, payload: JSON.stringify(payload) },
    });
    res.status(201).json({ success: true, vendor: normaliseVendor(payload) });
  } catch (err: any) {
    console.error('[mfg/vendors] POST:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/** PUT /api/manufacturing/vendors/:id */
router.put('/vendors/:id', requireManufacturingInstance, async (req: Request, res: Response) => {
  const inst    = req.mfgInstance!;
  const localId = Number(req.params.id);
  const { name, company_name, phone, whatsapp, address, email, ntn, notes } = req.body;
  if (!name?.trim()) { res.status(400).json({ success: false, error: 'Vendor name is required' }); return; }
  try {
    const payload = {
      id: localId, name: name.trim(),
      company_name: (company_name || '').trim(),
      phone:    (phone    || '').trim(),
      whatsapp: (whatsapp || '').trim(),
      address:  (address  || '').trim(),
      email:    (email    || '').trim(),
      ntn:      (ntn      || '').trim(),
      notes:    (notes    || '').trim(),
      updated_at: new Date().toISOString(),
    };
    await prisma.manufacturingSyncEvent.create({
      data: { instance_id: inst.id, entity_type: 'vendor', operation: 'update', local_id: localId, payload: JSON.stringify(payload) },
    });
    res.json({ success: true, vendor: normaliseVendor(payload) });
  } catch (err: any) {
    console.error('[mfg/vendors] PUT:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/** DELETE /api/manufacturing/vendors/:id */
router.delete('/vendors/:id', requireManufacturingInstance, async (req: Request, res: Response) => {
  const inst    = req.mfgInstance!;
  const localId = Number(req.params.id);
  try {
    await prisma.manufacturingSyncEvent.create({
      data: { instance_id: inst.id, entity_type: 'vendor', operation: 'delete', local_id: localId, payload: JSON.stringify({ id: localId }) },
    });
    res.json({ success: true });
  } catch (err: any) {
    console.error('[mfg/vendors] DELETE:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
