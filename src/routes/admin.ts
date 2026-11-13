import express, { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import multer from 'multer';
import { Prisma } from '@prisma/client';
import prisma from '../db';
import { requireAdmin } from '../middleware/auth';
import { RELEASES_DIR } from '../lib/releases';
import '../types';

// ─── Release installer upload (multipart) ───────────────────────────────────
// Stores the uploaded .exe/.msi on the VPS so the backend itself hosts the
// download — no external URL needed.
fs.mkdirSync(RELEASES_DIR, { recursive: true });

const releaseUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, RELEASES_DIR),
    filename: (_req, file, cb) => {
      const safe = file.originalname.replace(/[^\w.\-]+/g, '_');
      cb(null, `${Date.now()}-${safe}`);
    },
  }),
  limits: { fileSize: 600 * 1024 * 1024 }, // 600 MB ceiling
  fileFilter: (_req, file, cb) => {
    const ok = /\.(exe|msi|zip|dmg|appimage)$/i.test(file.originalname);
    cb(null, ok);
  },
});

// ─── License keygen — V3 format matching POS client license_manager.ts ──────
// Format: iv:authTag:ciphertext:hmac  (4 parts — POS rejects anything else)
// Keys must match the POS client exactly. Load from env — never hardcode.
const IV_LENGTH = 12;
const _licAesKey  = () => {
  const k = Buffer.from(process.env.OSATEC_AES_KEY_HEX  || '', 'hex');
  if (k.length !== 32) throw new Error('OSATEC_AES_KEY_HEX missing or wrong length (need 64 hex chars)');
  return k;
};
const _licHmacKey = () => {
  const k = Buffer.from(process.env.OSATEC_HMAC_KEY_HEX || '', 'hex');
  if (k.length !== 32) throw new Error('OSATEC_HMAC_KEY_HEX missing or wrong length (need 64 hex chars)');
  return k;
};

interface LicensePayload {
  v: 3;                          // Version marker — POS rejects v !== 3
  id: string; issuedTo: string; issuedForFingerprint: string;
  durationDays: number; maxDevices: number; issuedAt: string; expiresAt: string;
}

function generateLicenseKey(params: {
  issuedTo: string; fingerprint?: string; plan: string; durationDays?: number;
}): { licenseKey: string; expiresAt: string | null } {
  const aes  = _licAesKey();
  const hmac = _licHmacKey();

  const planDays: Record<string, number> = { monthly: 30, quarterly: 90, yearly: 365, lifetime: 36500 };
  const days     = params.durationDays || planDays[params.plan] || 30;
  const now      = new Date();
  const expires  = new Date(now.getTime() + days * 86_400_000);
  const expiresAt = params.plan === 'lifetime' ? null : expires.toISOString();

  const payload: LicensePayload = {
    v:                    3,                                // required by POS client
    id:                   uuidv4(),
    issuedTo:             params.issuedTo?.trim() || 'Unknown Business',
    issuedForFingerprint: params.fingerprint?.trim() || '*', // '*' = admin-issued, device not pre-bound
    durationDays:         days,
    maxDevices:           1,
    issuedAt:             now.toISOString(),
    expiresAt:            expires.toISOString(),
  };

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', aes, iv);
  let encrypted = cipher.update(JSON.stringify(payload), 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');

  // Outer HMAC-SHA256 over iv:authTag:ciphertext (POS verifies this before AES)
  const body = `${iv.toString('hex')}:${authTag}:${encrypted}`;
  const mac  = crypto.createHmac('sha256', hmac).update(body).digest('hex');

  return { licenseKey: `${body}:${mac}`, expiresAt };
}

// ─── Entity-from-sync helper ──────────────────────────────────────────────────
async function parseEntityFromSync(instanceId: string, entityType: string): Promise<any[]> {
  const events = await prisma.syncEvent.findMany({
    where:   { instance_id: instanceId, entity_type: entityType },
    orderBy: { id: 'asc' },
    select:  { operation: true, payload: true },
  });

  const map = new Map<string, any>();
  for (const ev of events) {
    let p: any;
    try { p = JSON.parse(ev.payload); } catch { continue; }
    if (!p) continue;
    const key = String(p?.id ?? p?.barcode ?? Math.random());
    if (ev.operation === 'delete') map.delete(key);
    else map.set(key, p);
  }
  return Array.from(map.values());
}

function toNumber(value: unknown): number {
  if (value == null || value === '') return 0;
  const n = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function getFirstNumber(source: Record<string, any>, keys: string[]): number {
  for (const key of keys) {
    const n = toNumber(source[key]);
    if (n > 0) return n;
  }
  return 0;
}

// Cap per-unit price/cost at 5 M PKR — mirrors the POS's MIN(price,5000000) DB guard.
// Without this, a single corrupted sync payload with a huge number inflates the
// whole stockValue/retailValue sum past the frontend's 1 B sanity limit → "Data error".
const MAX_UNIT_PKR = 5_000_000;

// Weight-based products (unit_type='gram'/'kg') store stock in their native unit.
// purchase_price and price_per_kg are always per-kg in the POS.
// Normalize so calculations are always in kg-equivalent units.
function normalizeProductStock(product: Record<string, any>): { stock: number; cost: number; salePrice: number } {
  const rawStock = Math.max(0, getFirstNumber(product, ['stock', 'quantity', 'qty', 'current_stock', 'stock_quantity', 'available_stock']));
  const rawCost  = getFirstNumber(product, ['purchase_price', 'cost_price', 'buying_price', 'wholesale_price', 'unit_cost', 'cost']);
  const cost     = Math.min(rawCost, MAX_UNIT_PKR);
  const unitType = String(product.unit_type || '').toLowerCase();
  const isGram   = unitType === 'gram';
  const isWeight = isGram || unitType === 'kg';
  // gram products: stock is in grams, convert to kg for value calculations
  const stock    = isGram ? rawStock / 1000 : rawStock;
  // weight products use price_per_kg as the retail price; regular products use price
  const pricePerKg  = Math.min(toNumber(product.price_per_kg), MAX_UNIT_PKR);
  const rawSalePrice = isWeight && pricePerKg > 0
    ? pricePerKg
    : getFirstNumber(product, ['price', 'sale_price', 'selling_price', 'retail_price']);
  const salePrice = Math.min(rawSalePrice, MAX_UNIT_PKR);
  return { stock, cost, salePrice };
}

function calculateInventoryStats(products: any[]) {
  return products.reduce(
    (acc, product) => {
      const { stock, cost, salePrice } = normalizeProductStock(product);
      acc.totalStock  += stock;
      acc.stockValue  += stock * cost;
      acc.retailValue += stock * salePrice;
      if (stock <= 0) acc.outOfStock += 1;
      if (stock > 0 && stock <= 5) acc.lowStock += 1;
      return acc;
    },
    {
      totalProducts: products.length,
      totalStock: 0,
      stockValue: 0,
      retailValue: 0,
      lowStock: 0,
      outOfStock: 0,
    },
  );
}

// ─── Money rules shared with the desktop POS (src/main/main.ts) ──────────────
// Desktop writes statuses in mixed case ('Completed','paid','Partial','Cancelled').
const lc = (v: unknown) => String(v ?? '').toLowerCase();
const isCancelledRow = (r: any) => lc(r?.status) === 'cancelled';
/** Revenue statuses on the desktop: completed / paid / partial (missing = default 'Completed'). */
const isActiveSale = (s: any) => ['completed', 'paid', 'partial'].includes(lc(s?.status ?? 'completed'));

/** Local (Pakistan) calendar day of a POS timestamp: ISO-UTC strings are shifted +5h; local 'YYYY-MM-DD HH:MM:SS' kept as is. */
const PK_OFFSET_MS = 5 * 3600_000;
function posDay(raw: unknown): string | null {
  if (raw == null || raw === '') return null;
  const s = String(raw);
  if (/[Tt].*(Z|[+-]\d{2}:?\d{2})$/.test(s)) {
    const d = new Date(s);
    if (!isNaN(d.getTime())) return new Date(d.getTime() + PK_OFFSET_MS).toISOString().slice(0, 10);
  }
  return s.slice(0, 10);
}
const pkToday = () => new Date(Date.now() + PK_OFFSET_MS).toISOString().slice(0, 10);
/** 'YYYY-MM-DD' → the following day, for exclusive upper bounds on mixed-format date strings. */
function nextDayStr(day: string): string {
  const d = new Date(`${String(day).slice(0, 10)}T00:00:00Z`);
  if (isNaN(d.getTime())) return `${day} 23:59:59`;
  return new Date(d.getTime() + 86_400_000).toISOString().slice(0, 10);
}

/** Cash handed back per sale for returns — new rows carry cash_refunded; older ones only have the account_txn. */
function refundsBySale(saleReturns: any[], accountTxns: any[]): Map<string, number> {
  const out = new Map<string, number>();
  const salesWithColumn = new Set<string>();
  for (const r of saleReturns) {
    if (r.cash_refunded == null || r.cash_refunded === '') continue;
    const sid = String(r.sale_id ?? '');
    salesWithColumn.add(sid);
    out.set(sid, (out.get(sid) ?? 0) + toNumber(r.cash_refunded));
  }
  for (const t of accountTxns) {
    if (lc(t.type) !== 'out' || lc(t.category) !== 'sale_return') continue;
    const m = /^Return for Sale #(\d+)/.exec(String(t.note ?? ''));
    if (!m || salesWithColumn.has(m[1])) continue;
    out.set(m[1], (out.get(m[1]) ?? 0) + toNumber(t.amount));
  }
  return out;
}

/** Invoice balance per customer — mirrors desktop recomputeCustomerBalance. */
function customerInvoiceBalances(sales: any[], payments: any[], saleReturns: any[], accountTxns: any[]): Map<string, number> {
  const saleCust = new Map<string, string>();
  const owed = new Map<string, number>();
  const add = (cid: string, v: number) => owed.set(cid, (owed.get(cid) ?? 0) + v);
  for (const s of sales) {
    const cid = String(s.customer_id ?? '');
    if (!cid || cid === 'null' || cid === '0' || isCancelledRow(s)) continue;
    saleCust.set(String(s.id), cid);
    add(cid, toNumber(s.total) - toNumber(s.write_off_amount));
  }
  for (const p of payments) {
    const cid = String(p.customer_id ?? '');
    if (!cid || cid === 'null' || cid === '0') continue;
    add(cid, -toNumber(p.amount));
  }
  const refunded = refundsBySale(saleReturns, accountTxns);
  const retBySale = new Map<string, number>();
  for (const r of saleReturns) {
    const sid = String(r.sale_id ?? '');
    retBySale.set(sid, (retBySale.get(sid) ?? 0) + toNumber(r.total_returned));
  }
  for (const [sid, ret] of retBySale) {
    const cid = saleCust.get(sid);
    if (cid) add(cid, -(ret - (refunded.get(sid) ?? 0)));
  }
  for (const [cid, v] of owed) owed.set(cid, Math.max(0, v));
  return owed;
}

/** Vendor payable per vendor — mirrors desktop get-vendors (may be negative = credit). */
function vendorPurchaseBalances(purchases: any[], payments: any[], purchaseReturns: any[]): Map<string, number> {
  const paidByPurchase = new Map<string, number>();
  const unlinked = new Map<string, number>();
  for (const p of payments) {
    const pid = p.purchase_id;
    if (pid == null || pid === '' || Number(pid) === 0) {
      const vid = String(p.vendor_id ?? '');
      unlinked.set(vid, (unlinked.get(vid) ?? 0) + toNumber(p.amount));
    } else {
      paidByPurchase.set(String(pid), (paidByPurchase.get(String(pid)) ?? 0) + toNumber(p.amount));
    }
  }
  const retByPurchase = new Map<string, number>();
  for (const r of purchaseReturns) {
    const pid = String(r.purchase_id ?? '');
    retByPurchase.set(pid, (retByPurchase.get(pid) ?? 0) + toNumber(r.total_returned ?? r.total));
  }
  const bal = new Map<string, number>();
  for (const p of purchases) {
    const vid = String(p.vendor_id ?? '');
    if (!vid || vid === 'null' || vid === '0' || isCancelledRow(p)) continue;
    const pid = String(p.id ?? '');
    const rem = Math.max(0, toNumber(p.total) - (paidByPurchase.get(pid) ?? 0) - (retByPurchase.get(pid) ?? 0));
    bal.set(vid, (bal.get(vid) ?? 0) + rem);
  }
  for (const [vid, amt] of unlinked) bal.set(vid, (bal.get(vid) ?? 0) - amt);
  return bal;
}

/** Open custom-bill balance per party (closed bills excluded, as on the desktop). */
function khataBalancesBy(khatas: any[], khataPayments: any[], partyKey: 'customer_id' | 'vendor_id'): Map<string, number> {
  const paid = new Map<string, number>();
  for (const p of khataPayments) {
    const kid = String(p.khata_id ?? '');
    paid.set(kid, (paid.get(kid) ?? 0) + toNumber(p.amount));
  }
  const bal = new Map<string, number>();
  for (const k of khatas) {
    if (lc(k.status) === 'closed') continue;
    const pid = String(k[partyKey] ?? '');
    if (!pid || pid === 'null' || pid === '0') continue;
    bal.set(pid, (bal.get(pid) ?? 0) + Math.max(0, toNumber(k.total_amount) - (paid.get(String(k.id)) ?? 0)));
  }
  return bal;
}

const COGS_UNIT_CAP = 1_000_000; // desktop P&L: MIN(si.purchase_price, 1000000)

/**
 * Revenue / COGS for active sales accepted by `keep` — desktop P&L rules:
 * revenue = Σ active totals − returns on those sales; COGS = Σ max(qty − returned, 0) × purchase_price.
 */
function salesPnl(sales: any[], saleItems: any[], saleReturns: any[], saleReturnItems: any[], keep: (s: any) => boolean) {
  const kept = sales.filter(s => isActiveSale(s) && keep(s));
  const ids = new Set(kept.map(s => String(s.id)));
  const revenueGross = kept.reduce((a, s) => a + toNumber(s.total), 0);
  const returned = saleReturns.filter(r => ids.has(String(r.sale_id))).reduce((a, r) => a + toNumber(r.total_returned), 0);
  const retQty = new Map<string, number>();
  for (const ri of saleReturnItems) {
    const k = String(ri.sale_item_id ?? '');
    retQty.set(k, (retQty.get(k) ?? 0) + toNumber(ri.quantity));
  }
  let cogs = 0, itemsWithCost = 0;
  for (const si of saleItems) {
    if (!ids.has(String(si.sale_id))) continue;
    const pp = Math.min(toNumber(si.purchase_price), COGS_UNIT_CAP);
    if (pp <= 0) continue;
    itemsWithCost++;
    cogs += Math.max(toNumber(si.quantity) - (retQty.get(String(si.id ?? '')) ?? 0), 0) * pp;
  }
  return { count: kept.length, revenue: revenueGross - returned, cogs, itemsWithCost, kept };
}

// ─── Export-all helper ────────────────────────────────────────────────────────
// Maps singular entity_type (used in sync_events) → plural SQLite table name.
// Must be kept in sync with full-resync entity types in main.ts.
const ENTITY_TO_TABLE: Record<string, string> = {
  // Core
  product:               'products',
  customer:              'customers',
  vendor:                'vendors',
  employee:              'employees',
  employee_advance:      'employee_advances',
  settings:              'settings',
  // Sales
  sale:                  'sales',
  sale_item:             'sale_items',
  sale_return:           'sale_returns',
  sale_return_item:      'sale_return_items',
  // Purchases & Stock
  purchase:              'purchases',
  inventory_batch:       'inventory_batches',
  purchase_return:       'purchase_returns',
  purchase_return_item:  'purchase_return_items',
  stock_adjustment:      'stock_adjustments',
  // Payments
  customer_payment:      'customer_payments',
  vendor_payment:        'vendor_payments',
  // Finance
  expense:               'expenses',
  account:               'accounts',
  account_txn:           'account_txns',
  register:              'registers',
  financial_transaction: 'financial_transactions',
  // History
  entity_history:        'entity_history',
  // Khata (credit ledger)
  customer_khata:         'customer_khatas',
  customer_khata_payment: 'customer_khata_payments',
  vendor_khata:           'vendor_khatas',
  vendor_khata_payment:   'vendor_khata_payments',
  // Route book
  customer_location:        'customer_locations',
  customer_location_member: 'customer_location_members',
  // DMS
  dms_company:         'dms_companies',
  dms_order:           'dms_orders',
  dms_partner_drawing: 'dms_partner_drawings',
  dms_recovery:        'dms_recoveries',
  // Agreement
  agreement:           'agreements',
  // POS Users
  pos_user:            'pos_users',
};

async function buildExportPayload(instanceId: string) {
  const rawEvents = await prisma.syncEvent.findMany({
    where:   { instance_id: instanceId },
    orderBy: { id: 'asc' },
  });

  const entityMap: Record<string, Map<string, any>> = {};
  for (const event of rawEvents) {
    const type = event.entity_type;
    if (!entityMap[type]) entityMap[type] = new Map();
    let payload: any;
    try { payload = JSON.parse(event.payload); } catch { continue; }
    if (!payload) continue;
    const key = String(payload?.id ?? payload?.barcode ?? event.id);
    if (event.operation === 'delete') entityMap[type].delete(key);
    else entityMap[type].set(key, payload);
  }

  const structured: Record<string, any[]> = {};
  for (const [type, items] of Object.entries(entityMap)) structured[type] = Array.from(items.values());

  const exportPayload: Record<string, any[]> = {};
  for (const [singular, plural] of Object.entries(ENTITY_TO_TABLE)) {
    exportPayload[plural] = structured[singular] || [];
  }
  for (const [type, items] of Object.entries(structured)) {
    if (!ENTITY_TO_TABLE[type]) exportPayload[type] = items;
  }
  if (!exportPayload.sales?.length) {
    exportPayload.sales = await prisma.instanceSale.findMany({
      where: { instance_id: instanceId }, orderBy: { date_created: 'asc' },
    }) as any[];
  }

  return { exportPayload, rawEventsCount: rawEvents.length };
}

// ─── Router ───────────────────────────────────────────────────────────────────
const router = Router();
router.use(requireAdmin);

// ── Manufacturing (Factory ERP) instances — separate table from POS Instance ──
// List, most-recently-active first, pending ones easy to spot via approval_status.
router.get('/manufacturing/instances', async (_req: Request, res: Response) => {
  const instances = await prisma.manufacturingInstance.findMany({ orderBy: { created_at: 'desc' } });
  // password_hash never leaves the server; password_plain rides along for admin
  // support ("customer forgot their password") — same pattern as POS's Instance.
  const safe = instances.map(({ password_hash, ...rest }) => rest);
  res.json({ success: true, instances: safe });
});

// ── Set / reset a manufacturing install's password (admin support) ────────────
router.post('/manufacturing/instances/:id/set-password', async (req: Request, res: Response) => {
  try {
    const { password } = req.body as { password?: string };
    if (!password || password.trim().length < 4) {
      res.status(400).json({ success: false, error: 'Password must be at least 4 characters' });
      return;
    }
    const id = Number(req.params.id);
    const inst = await prisma.manufacturingInstance.findUnique({ where: { id } });
    if (!inst) { res.status(404).json({ success: false, error: 'Instance not found' }); return; }

    const hash = await (await import('bcryptjs')).hash(password.trim(), 10);
    await prisma.manufacturingInstance.update({
      where: { id },
      data: { password_hash: hash, password_plain: password.trim() },
    });
    res.json({ success: true, message: 'Password updated' });
  } catch (e: any) {
    console.error('[manufacturing set-password]', e.message);
    res.status(500).json({ success: false, error: e.message || 'Failed to set password' });
  }
});

// Approve a pending (or re-approve a blocked) installation and allocate a plan:
// { plan: 'monthly' | 'lifetime', duration_days?: number }. Mirrors POS's
// /instances/:id/approve — same shape, just against ManufacturingInstance.
router.post('/manufacturing/instances/:id/approve', async (req: Request, res: Response) => {
  const { plan, duration_days } = req.body as { plan?: string; duration_days?: number };
  const id = Number(req.params.id);
  const existing = await prisma.manufacturingInstance.findUnique({ where: { id } });
  if (!existing) { res.status(404).json({ success: false, error: 'Instance not found' }); return; }

  let license_plan = existing.license_plan;
  let license_expiry: string | null = existing.license_expiry;
  if (plan === 'lifetime') {
    license_plan = 'lifetime';
    license_expiry = null;
  } else if (plan === 'monthly') {
    const days = Number(duration_days) || 30;
    license_plan = 'monthly';
    license_expiry = new Date(Date.now() + days * 86_400_000).toISOString();
  }

  const updated = await prisma.manufacturingInstance.update({
    where: { id },
    data: { approval_status: 'approved', license_plan, license_expiry },
  });
  res.json({ success: true, instance: updated });
});

router.post('/manufacturing/instances/:id/block', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  await prisma.manufacturingInstance.update({ where: { id }, data: { approval_status: 'blocked' } });
  res.json({ success: true });
});

router.post('/manufacturing/instances/:id/unblock', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  await prisma.manufacturingInstance.update({ where: { id }, data: { approval_status: 'approved' } });
  res.json({ success: true });
});

// Raw synced-record browser — every create/update/delete this install has pushed,
// most recent first. `entity_type` (sale|purchase|product|part|customer|vendor)
// narrows the feed; `payload` is returned parsed for the frontend table.
router.get('/manufacturing/instances/:id/events', async (req: Request, res: Response) => {
  const instance_id = Number(req.params.id);
  const entity_type = typeof req.query.entity_type === 'string' ? req.query.entity_type : undefined;
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Number(req.query.offset) || 0;

  const events = await prisma.manufacturingSyncEvent.findMany({
    where: { instance_id, ...(entity_type ? { entity_type } : {}) },
    orderBy: { received_at: 'desc' },
    take: limit,
    skip: offset,
  });
  res.json({
    success: true,
    events: events.map(e => ({ ...e, payload: (() => { try { return JSON.parse(e.payload); } catch { return e.payload; } })() })),
  });
});

// Flattened sales feed for an instance — backs the Sales tab in the admin's
// manufacturing instance detail page.
router.get('/manufacturing/instances/:id/sales', async (req: Request, res: Response) => {
  const instance_id = Number(req.params.id);
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Number(req.query.offset) || 0;

  const sales = await prisma.manufacturingInstanceSale.findMany({
    where: { instance_id },
    orderBy: { synced_at: 'desc' },
    take: limit,
    skip: offset,
  });
  res.json({ success: true, sales });
});

// ── Stats ─────────────────────────────────────────────────────────────────────
router.get('/stats', async (_req: Request, res: Response) => {
  const now     = new Date();
  const day1ago = new Date(now.getTime() - 86_400_000);
  const day7ago = new Date(now.getTime() - 7 * 86_400_000);

  const [totalInstances, pending, blocked, approved, activeToday, activeWeek, pendingUploads] = await Promise.all([
    prisma.instance.count(),
    prisma.instance.count({ where: { approval_status: 'pending' } }),
    prisma.instance.count({ where: { approval_status: 'blocked' } }),
    prisma.instance.count({ where: { approval_status: 'approved' } }),
    prisma.instance.count({ where: { last_seen: { gte: day1ago } } }),
    prisma.instance.count({ where: { last_seen: { gte: day7ago } } }),
    prisma.instance.count({ where: { db_upload_status: 'requested' } as any }),
  ]);

  const [revRow, salesRow, licensesIssued, licensesAssigned] = await Promise.all([
    prisma.instance.aggregate({ _sum: { total_revenue: true } }),
    prisma.instance.aggregate({ _sum: { total_sales:   true } }),
    prisma.licenseKey.count({ where: { is_active: true } }),
    prisma.licenseKey.count({ where: { instance_id: { not: null } } }),
  ]);

  // License expiry alerts — raw SQL for date arithmetic on string field
  const [expiringCritical, expiringWarning, expired] = await Promise.all([
    prisma.$queryRaw<any[]>(Prisma.sql`
      SELECT instance_id, store_name, owner_mobile, license_plan, license_expiry,
        CAST(EXTRACT(EPOCH FROM (CAST(license_expiry AS TIMESTAMP WITH TIME ZONE) - NOW())) / 86400 AS INTEGER) AS days_left
      FROM instances
      WHERE approval_status = 'approved'
        AND license_expiry IS NOT NULL AND license_expiry != ''
        AND CAST(license_expiry AS TIMESTAMP WITH TIME ZONE) >= NOW()
        AND CAST(license_expiry AS TIMESTAMP WITH TIME ZONE) <= NOW() + INTERVAL '7 days'
      ORDER BY license_expiry ASC
    `),
    prisma.$queryRaw<any[]>(Prisma.sql`
      SELECT instance_id, store_name, owner_mobile, license_plan, license_expiry,
        CAST(EXTRACT(EPOCH FROM (CAST(license_expiry AS TIMESTAMP WITH TIME ZONE) - NOW())) / 86400 AS INTEGER) AS days_left
      FROM instances
      WHERE approval_status = 'approved'
        AND license_expiry IS NOT NULL AND license_expiry != ''
        AND CAST(license_expiry AS TIMESTAMP WITH TIME ZONE) > NOW() + INTERVAL '7 days'
        AND CAST(license_expiry AS TIMESTAMP WITH TIME ZONE) <= NOW() + INTERVAL '30 days'
      ORDER BY license_expiry ASC
    `),
    prisma.$queryRaw<any[]>(Prisma.sql`
      SELECT instance_id, store_name, owner_mobile, license_plan, license_expiry,
        CAST(EXTRACT(EPOCH FROM (NOW() - CAST(license_expiry AS TIMESTAMP WITH TIME ZONE))) / 86400 AS INTEGER) AS days_overdue
      FROM instances
      WHERE approval_status = 'approved'
        AND license_expiry IS NOT NULL AND license_expiry != ''
        AND CAST(license_expiry AS TIMESTAMP WITH TIME ZONE) < NOW()
      ORDER BY license_expiry ASC
    `),
  ]);

  res.json({
    success: true,
    data: {
      totalInstances, pending, blocked, approved, activeToday, activeWeek,
      pendingUploads,   // stores waiting for DB upload approval
      totalRevenue:    Number(revRow._sum.total_revenue  || 0),
      totalSales:      Number(salesRow._sum.total_sales  || 0),
      licensesIssued, licensesAssigned,
      expiringCritical, expiringWarning, expired,
    },
  });
});

// ── Instances list ─────────────────────────────────────────────────────────────
router.get('/instances', async (req: Request, res: Response) => {
  const { status, search, limit = '50', offset = '0', date_from, date_to } = req.query as Record<string, string>;
  const lim = Number(limit);
  const off = Number(offset);
  const hasDateFilter = !!(date_from && date_to);

  // Build where filter
  const where: Prisma.InstanceWhereInput = {};
  if (status) where.approval_status = status;
  if (search) {
    const pat = `%${search}%`;
    where.OR = [
      { store_name:    { contains: search, mode: 'insensitive' } },
      { owner_mobile:  { contains: search } },
      { owner_name:    { contains: search, mode: 'insensitive' } },
      { business_name: { contains: search, mode: 'insensitive' } },
    ];
  }

  const total = await prisma.instance.count({ where });

  if (hasDateFilter) {
    // Need a LEFT JOIN with period-filtered sales — use raw SQL
    const conditions: Prisma.Sql[] = [];
    if (status) conditions.push(Prisma.sql`i.approval_status = ${status}`);
    if (search) {
      const pat = `%${search}%`;
      conditions.push(Prisma.sql`(i.store_name ILIKE ${pat} OR i.owner_mobile LIKE ${pat} OR i.owner_name ILIKE ${pat} OR i.business_name ILIKE ${pat})`);
    }
    const whereClause = conditions.length > 0
      ? Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}`
      : Prisma.empty;

    const dateFrom = date_from;
    // Exclusive next-day bound: '<= 2026-08-01 23:59:59' dropped ISO rows ('2026-08-01T…' sorts after ' ').
    const dateTo   = nextDayStr(date_to);
    const rows = await prisma.$queryRaw<any[]>(Prisma.sql`
      SELECT
        i.id, i.instance_id, i.store_name, i.owner_name, i.owner_mobile, i.owner_email,
        i.store_address, i.business_name, i.license_plan, i.license_expiry, i.license_key,
        i.approval_status, i.block_reason, i.last_seen, i.app_version, i.branch_name,
        COALESCE(ps.period_sales,   0) AS total_sales,
        COALESCE(ps.period_revenue, 0) AS total_revenue,
        i.total_customers, i.total_products, i.device_fingerprint, i.created_at, i.updated_at
      FROM instances i
      LEFT JOIN (
        SELECT instance_id,
               COUNT(*)::int                                         AS period_sales,
               COALESCE(ROUND(SUM(total)::numeric, 0), 0)::float    AS period_revenue
        FROM instance_sales
        WHERE date_created >= ${dateFrom} AND date_created < ${dateTo}
          AND LOWER(COALESCE(status, 'completed')) IN ('completed', 'paid', 'partial')
        GROUP BY instance_id
      ) ps ON ps.instance_id = i.instance_id
      ${whereClause}
      ORDER BY CASE WHEN i.approval_status = 'pending' THEN 0 ELSE 1 END, i.created_at DESC
      LIMIT ${lim} OFFSET ${off}
    `);

    return res.json({ success: true, data: rows, total });
  }

  // No date filter — simple Prisma query
  const rows = await prisma.instance.findMany({
    where,
    orderBy: [
      // pending first — simulate the CASE ordering
      { created_at: 'desc' },
    ],
    take:   lim,
    skip:   off,
  });

  // Sort pending first in JS (simpler than raw SQL)
  rows.sort((a, b) => {
    const ap = a.approval_status === 'pending' ? 0 : 1;
    const bp = b.approval_status === 'pending' ? 0 : 1;
    if (ap !== bp) return ap - bp;
    return b.created_at.getTime() - a.created_at.getTime();
  });

  res.json({ success: true, data: rows, total });
});

// ── Delete single instance ────────────────────────────────────────────────────
/**
 * DELETE /api/admin/instances/:id
 *
 * Permanently deletes one store and ALL associated data:
 *   sync_events, instance_sales, notification_reads.
 * License keys are de-assigned (not deleted) so they can be reused.
 */
router.delete('/instances/:id', async (req: Request, res: Response) => {
  const instanceId = req.params.id;
  const inst = await prisma.instance.findUnique({ where: { instance_id: instanceId } });
  if (!inst) { res.status(404).json({ success: false, error: 'Instance not found' }); return; }

  // Confirmation header required to prevent accidental deletion
  const confirm = req.headers['x-confirm-delete'];
  if (confirm !== instanceId) {
    res.status(400).json({
      success: false,
      error: 'Missing confirmation. Set header x-confirm-delete to the instance_id.',
    });
    return;
  }

  await prisma.$transaction([
    // Orphan any license keys (keep the key itself — can be reassigned)
    prisma.licenseKey.updateMany({
      where: { instance_id: instanceId },
      data:  { instance_id: null },
    }),
    // Delete all associated data
    prisma.notificationRead.deleteMany({ where: { instance_id: instanceId } }),
    prisma.syncEvent.deleteMany({ where: { instance_id: instanceId } }),
    prisma.instanceSale.deleteMany({ where: { instance_id: instanceId } }),
    // Finally delete the instance itself
    prisma.instance.delete({ where: { instance_id: instanceId } }),
  ]);

  res.json({
    success: true,
    message: `Instance "${inst.store_name}" (${instanceId}) and all associated data permanently deleted.`,
  });
});

// ── Delete ALL instances (nuclear reset) ──────────────────────────────────────
/**
 * DELETE /api/admin/instances
 *
 * Permanently deletes EVERY instance and ALL sync data.
 * Requires confirmation phrase in x-confirm-delete header.
 * Licenses, notifications, releases are NOT deleted.
 */
router.delete('/instances', async (req: Request, res: Response) => {
  const confirm = req.headers['x-confirm-delete'];
  if (confirm !== 'DELETE_ALL_INSTANCES') {
    res.status(400).json({
      success: false,
      error: 'Send header x-confirm-delete: DELETE_ALL_INSTANCES to proceed.',
    });
    return;
  }

  const count = await prisma.instance.count();

  await prisma.$transaction([
    prisma.notificationRead.deleteMany({}),
    prisma.syncEvent.deleteMany({}),
    prisma.instanceSale.deleteMany({}),
    // Unassign all license keys
    prisma.licenseKey.updateMany({ where: {}, data: { instance_id: null } }),
    prisma.instance.deleteMany({}),
  ]);

  res.json({
    success: true,
    message: `All ${count} instances and their data have been permanently deleted.`,
    deleted: count,
  });
});

// ── Instance detail ────────────────────────────────────────────────────────────
router.get('/instances/:id', async (req: Request, res: Response) => {
  const instance = await prisma.instance.findUnique({ where: { instance_id: req.params.id } });
  if (!instance) { res.status(404).json({ success: false, error: 'Instance not found' }); return; }

  const [recentEvents, products, storageSizeRows, sales, saleItems, saleReturns, saleReturnItems] = await Promise.all([
    prisma.syncEvent.findMany({
      where:   { instance_id: req.params.id },
      orderBy: { id: 'desc' },
      take:    100,
      select:  { id: true, entity_type: true, operation: true, received_at: true },
    }),
    parseEntityFromSync(req.params.id, 'product'),
    prisma.$queryRaw<Array<{ total_bytes: bigint }>>(
      Prisma.sql`SELECT COALESCE(SUM(octet_length(payload)), 0) AS total_bytes FROM sync_events WHERE instance_id = ${req.params.id}`
    ),
    // Latest state per entity (not every create event): edits, cancels and deletes must apply,
    // and re-synced rows must not count twice.
    parseEntityFromSync(req.params.id, 'sale'),
    parseEntityFromSync(req.params.id, 'sale_item'),
    parseEntityFromSync(req.params.id, 'sale_return'),
    parseEntityFromSync(req.params.id, 'sale_return_item'),
  ]);

  const inventoryStats = calculateInventoryStats(products);
  const storageMb = Number(storageSizeRows[0]?.total_bytes ?? 0) / (1024 * 1024);

  const pnl = salesPnl(sales, saleItems, saleReturns, saleReturnItems, () => true);
  const synced_revenue = Math.round(pnl.revenue * 100) / 100;
  const itemsWithCost  = pnl.itemsWithCost;
  const gross_profit   = itemsWithCost > 0 ? Math.round(pnl.revenue - pnl.cogs) : null;
  const saleDays = pnl.kept.map((s: any) => posDay(s.date_created || s.date_added || s.date)).filter(Boolean) as string[];
  const salesStats = {
    _count: { id: pnl.count },
    _max:   { date_created: saleDays.length ? saleDays.reduce((a, b) => (a > b ? a : b)) : null },
  };

  // Days active: from first sale date to today (min 1)
  const firstSale = saleDays.length ? saleDays.reduce((a, b) => (a < b ? a : b)) : null;
  const daysActive = firstSale
    ? Math.max(1, Math.ceil((Date.now() - new Date(firstSale).getTime()) / 86_400_000))
    : null;
  const gross_profit_per_day = (gross_profit != null && daysActive) ? Math.round(gross_profit / daysActive) : null;

  // Derive modules: prefer synced settings entity; fall back to active_modules string from heartbeat
  const settingsEvents = await parseEntityFromSync(req.params.id, 'settings');
  const syncedSettings: any = settingsEvents[0] ?? null;
  const MODULE_KEYS_ADMIN = [
    'dms', 'wholesale', 'pharmacy', 'accounting', 'attendance', 'bakery',
    'grocery', 'restaurant', 'clothing', 'electronics', 'accessories',
    'dry_fruits', 'paint', 'mobile', 'laptop', 'urdu', 'product_images',
  ];
  let derivedModules: Record<string, boolean> = {};
  let derivedEnabledModules: string[] = [];
  if (syncedSettings) {
    for (const m of MODULE_KEYS_ADMIN) {
      const key = m === 'product_images' ? 'product_images_enabled' : `${m}_module_enabled`;
      derivedModules[m] = !!(syncedSettings[key] ?? 0);
    }
    derivedEnabledModules = MODULE_KEYS_ADMIN.filter(m => derivedModules[m]);
  } else {
    // Fallback: parse from the active_modules string saved by heartbeat/register
    const rawStr: string = (instance as any).active_modules || '';
    if (rawStr.trim()) {
      derivedEnabledModules = rawStr.split(',').map((s: string) => s.trim()).filter(Boolean);
      for (const m of derivedEnabledModules) derivedModules[m] = true;
    }
  }

  // Strip password_hash; keep password_plain for admin support viewing
  const { password_hash, password_plain, ...instanceSafe } = instance as any;

  res.json({
    success: true,
    data: {
      instance: {
        ...instanceSafe,
        has_password:     !!(password_hash),
        current_password: password_plain || '',   // plain-text — admin eyes only
        modules:          derivedModules,
        enabled_modules:  derivedEnabledModules,
        active_modules:   derivedEnabledModules.join(', '),
      },
      recentEvents,
      inventoryStats,
      storage_mb: Math.round(storageMb * 100) / 100,
      salesStats: {
        total_synced_sales:   salesStats._count.id,
        synced_revenue,
        last_sale_date:       salesStats._max.date_created,
        first_sale_date:      firstSale,
        gross_profit,
        gross_profit_per_day,
        days_active:          daysActive,
        cogs_coverage_items:  itemsWithCost,  // how many items had cost data
      },
    },
  });
});

// ── Recalculate stats from raw sync data ──────────────────────────────────────
// Derives inventory stats and sales stats entirely from sync_events, ignoring
// corrupted price fields on product records (uses sale_items as ground truth).
router.post('/instances/:id/recalculate', async (req: Request, res: Response) => {
  const instance = await prisma.instance.findUnique({ where: { instance_id: req.params.id }, select: { id: true } });
  if (!instance) { res.status(404).json({ success: false, error: 'Instance not found' }); return; }

  const [sales, saleItems, saleReturns, saleReturnItems, customerPayments, products, expenses, accountTxns] = await Promise.all([
    parseEntityFromSync(req.params.id, 'sale'),
    parseEntityFromSync(req.params.id, 'sale_item'),
    parseEntityFromSync(req.params.id, 'sale_return'),
    parseEntityFromSync(req.params.id, 'sale_return_item'),
    parseEntityFromSync(req.params.id, 'customer_payment'),
    parseEntityFromSync(req.params.id, 'product'),
    parseEntityFromSync(req.params.id, 'expense'),
    parseEntityFromSync(req.params.id, 'account_txn'),
  ]);

  // Desktop P&L rules: active sales only, returns only on those sales, COGS on net quantity.
  const pnl = salesPnl(sales, saleItems, saleReturns, saleReturnItems, () => true);
  const activeSales = pnl.kept;
  const activeSaleIds = new Set(activeSales.map((s: any) => String(s.id)));
  const activeSaleItems = saleItems.filter((si: any) => activeSaleIds.has(String(si.sale_id)));
  const netRevenue = pnl.revenue;
  const totalCOGS = pnl.cogs;
  const itemsWithCost = pnl.itemsWithCost;

  const hasGP = itemsWithCost > 0;
  const gross_profit = hasGP ? Math.round(netRevenue - totalCOGS) : null;

  // Date range from active sales
  const saleDates = activeSales.map((s: any) => posDay(s.date_created || s.date_added || s.date)).filter(Boolean) as string[];
  const firstSaleDate = saleDates.length > 0 ? saleDates.reduce((a: string, b: string) => a < b ? a : b) : null;
  const lastSaleDate  = saleDates.length > 0 ? saleDates.reduce((a: string, b: string) => a > b ? a : b) : null;
  const daysActive = firstSaleDate
    ? Math.max(1, Math.ceil((Date.now() - new Date(firstSaleDate).getTime()) / 86_400_000))
    : null;
  const gross_profit_per_day = (gross_profit != null && daysActive) ? Math.round(gross_profit / daysActive) : null;

  // Derive last-known real price per product from sale_items to fix corrupted product records
  const derivedPriceMap = new Map<string, { price: number; cost: number }>();
  for (const si of activeSaleItems) {
    const pid = String(si.product_id ?? '');
    if (!pid) continue;
    const price = parseFloat(si.price) || parseFloat(si.sale_price) || 0;
    const cost  = parseFloat(si.purchase_price) || 0;
    if (price > 0 && price <= MAX_UNIT_PKR) {
      derivedPriceMap.set(pid, { price, cost: Math.min(cost, MAX_UNIT_PKR) });
    }
  }

  // Fix corrupted product prices before computing inventory stats
  const correctedProducts = products.map((p: any) => {
    const pid = String(p.id ?? p.barcode ?? '');
    const derived = pid ? derivedPriceMap.get(pid) : undefined;
    if (!derived) return p;
    const rawPrice = getFirstNumber(p, ['price', 'sale_price', 'selling_price', 'retail_price']);
    const rawCost  = getFirstNumber(p, ['purchase_price', 'cost_price', 'buying_price', 'wholesale_price', 'unit_cost', 'cost']);
    return {
      ...p,
      price:          rawPrice > MAX_UNIT_PKR ? derived.price : p.price,
      purchase_price: rawCost  > MAX_UNIT_PKR ? derived.cost  : p.purchase_price,
    };
  });
  const inventoryStats = calculateInventoryStats(correctedProducts);

  // Customer outstanding: computed fresh from sales - returns - payments
  // (never trusts stored outstanding_balance which may be corrupted)
  const customerDebt = Array.from(customerInvoiceBalances(sales, customerPayments, saleReturns, accountTxns).values())
    .reduce((sum, v) => sum + v, 0);

  const totalExpenses = expenses.reduce((s: number, e: any) => s + toNumber(e.amount), 0);

  const rnd = (v: number) => Math.round(v * 100) / 100;
  res.json({
    success: true,
    data: {
      inventoryStats,
      salesStats: {
        total_synced_sales:   activeSales.length,
        synced_revenue:       rnd(netRevenue),
        last_sale_date:       lastSaleDate,
        first_sale_date:      firstSaleDate,
        gross_profit,
        gross_profit_per_day,
        days_active:          daysActive,
        cogs_coverage_items:  itemsWithCost,
      },
      customer_debt:  rnd(customerDebt),
      total_expenses: rnd(totalExpenses),
    },
  });
});

// ── Set / reset customer password ─────────────────────────────────────────────
router.post('/instances/:id/set-password', async (req: Request, res: Response) => {
  try {
    const { password } = req.body as { password?: string };
    if (!password || password.trim().length < 4) {
      res.status(400).json({ success: false, error: 'Password must be at least 4 characters' });
      return;
    }
    const inst = await prisma.instance.findUnique({ where: { instance_id: req.params.id } });
    if (!inst) { res.status(404).json({ success: false, error: 'Instance not found' }); return; }

    const hash = await (await import('bcryptjs')).hash(password.trim(), 10);
    await prisma.instance.update({
      where: { instance_id: req.params.id },
      data:  { password_hash: hash, password_plain: password.trim() },
    });
    res.json({ success: true, message: 'Password updated' });
  } catch (e: any) {
    console.error('[set-password]', e.message);
    res.status(500).json({ success: false, error: e.message || 'Failed to set password' });
  }
});

// ── Approve ────────────────────────────────────────────────────────────────────
// NOTE: Express 4 does NOT auto-forward async rejections to the error handler.
// Every async route MUST have its own try/catch, otherwise a throw (e.g. from
// generateLicenseKey when env keys are missing, or a Prisma error) will leave
// the response permanently open and the client will time-out after 30 s.
router.post('/instances/:id/approve', async (req: Request, res: Response) => {
  try {
    const { plan, duration_days, notes } = req.body as { plan?: string; duration_days?: number; notes?: string };
    const instanceId = req.params.id;

    const existing = await prisma.instance.findUnique({ where: { instance_id: instanceId } });
    if (!existing) { res.status(404).json({ success: false, error: 'Instance not found' }); return; }

    let licenseKey: string | null = null;
    let expiresAt:  string | null = null;
    const resolvedPlan = plan || null;

    if (plan) {
      const defaultDays: Record<string, number> = { monthly: 30, quarterly: 90, yearly: 365, lifetime: 36500 };
      const days = Number(duration_days) || defaultDays[plan] || 30;
      const issuedTo = (existing.store_name || existing.business_name || '').trim() || 'Unknown Business';
      const generated = generateLicenseKey({ issuedTo, fingerprint: '', plan, durationDays: days });
      licenseKey = generated.licenseKey;
      expiresAt  = generated.expiresAt;

      await prisma.licenseKey.create({
        data: { license_key: licenseKey, instance_id: instanceId, plan, duration_days: days, expires_at: expiresAt, notes: notes || '' },
      });
    }

    await prisma.instance.update({
      where: { instance_id: instanceId },
      data: {
        approval_status: 'approved',
        block_reason:    '',
        license_revoked: 0,
        ...(licenseKey ? { license_key: licenseKey, license_plan: resolvedPlan!, license_expiry: expiresAt } : {}),
      },
    });

    res.json({ success: true, message: `Instance ${instanceId} approved`, licenseKey, plan: resolvedPlan, expiresAt });
  } catch (e: any) {
    console.error('[approve]', e.message);
    res.status(500).json({ success: false, error: e.message || 'Approval failed' });
  }
});

// ── Block license ──────────────────────────────────────────────────────────────
router.post('/instances/:id/block-license', async (req: Request, res: Response) => {
  const { reason } = req.body as { reason?: string };
  const inst = await prisma.instance.findUnique({ where: { instance_id: req.params.id } });
  if (!inst) { res.status(404).json({ success: false, error: 'Instance not found' }); return; }

  if (inst.license_key) {
    await prisma.licenseKey.updateMany({ where: { license_key: inst.license_key }, data: { is_active: false } });
  }

  await prisma.instance.update({
    where: { instance_id: req.params.id },
    data: {
      approval_status: 'blocked', license_revoked: 1,
      license_key: '', license_plan: 'none', license_expiry: null,
      block_reason: reason || 'License revoked by admin',
    },
  });

  res.json({ success: true, message: 'License revoked — POS will clear local license on next sync' });
});

// ── License restore preview ────────────────────────────────────────────────────
// Returns whether this instance has a restorable (previously deactivated) key.
// Used by the frontend to decide which unblock options to show.
router.get('/instances/:id/license-preview', async (req: Request, res: Response) => {
  const prev = await prisma.licenseKey.findFirst({
    where:   { instance_id: req.params.id, is_active: false },
    orderBy: { issued_at: 'desc' },
    select:  { license_key: true, plan: true, expires_at: true, duration_days: true },
  });
  res.json({ success: true, has_previous: !!prev, previous: prev ?? null });
});

// ── Unblock license ────────────────────────────────────────────────────────────
// Always regenerates a fresh key (correct format) instead of restoring the old
// stale one — old keys may have been generated before the V3 format fix.
router.post('/instances/:id/unblock-license', async (req: Request, res: Response) => {
  try {
    const inst = await prisma.instance.findUnique({ where: { instance_id: req.params.id } });
    if (!inst) { res.status(404).json({ success: false, error: 'Instance not found' }); return; }

    // Find the most recent (possibly stale) key for plan/duration info — but do NOT restore it
    const prevKey = await prisma.licenseKey.findFirst({
      where:   { instance_id: req.params.id },
      orderBy: { issued_at: 'desc' },
    });

    const plan         = prevKey?.plan          || (inst as any).license_plan || 'monthly';
    const durationDays = prevKey?.duration_days || 30;
    const issuedTo     = (inst.store_name || inst.business_name || '').trim() || 'Unknown Business';

    // Generate a fresh key in the correct V3 format
    const generated = generateLicenseKey({ issuedTo, plan, durationDays });
    const newLicenseKey = generated.licenseKey;
    const newExpiresAt  = generated.expiresAt;

    await prisma.$transaction([
      // Deactivate all previous keys for this instance
      prisma.licenseKey.updateMany({
        where: { instance_id: req.params.id },
        data:  { is_active: false },
      }),
      // Insert the new correct key
      prisma.licenseKey.create({
        data: { license_key: newLicenseKey, instance_id: req.params.id, plan, duration_days: durationDays, expires_at: newExpiresAt, notes: 'Regenerated on unblock' },
      }),
      // Restore approval with the new key
      prisma.instance.update({
        where: { instance_id: req.params.id },
        data: {
          approval_status: 'approved', license_revoked: 0, block_reason: '',
          cloud_blocked:   false,
          license_key:     newLicenseKey,
          license_plan:    plan,
          license_expiry:  newExpiresAt,
        },
      }),
    ]);

    res.json({ success: true, message: 'License unblocked with a fresh key.', license_key: newLicenseKey, license_plan: plan, expires_at: newExpiresAt });
  } catch (e: any) {
    console.error('[unblock-license]', e.message);
    res.status(500).json({ success: false, error: e.message || 'Unblock failed' });
  }
});

// ── Cloud-only block (soft block) ─────────────────────────────────────────────
// Suspends cloud sync — POS keeps running locally but cannot push/pull data.
// Does NOT touch approval_status or license_revoked.
router.post('/instances/:id/block-cloud', async (req: Request, res: Response) => {
  const { reason } = req.body as { reason?: string };
  const inst = await prisma.instance.findUnique({ where: { instance_id: req.params.id } });
  if (!inst) { res.status(404).json({ success: false, error: 'Instance not found' }); return; }

  await prisma.instance.update({
    where: { instance_id: req.params.id },
    data:  { cloud_blocked: true, block_reason: reason || 'Cloud sync suspended by admin' },
  });
  res.json({ success: true, message: `Cloud sync suspended for ${req.params.id}` });
});

// ── Unblock cloud (lift soft block) ───────────────────────────────────────────
router.post('/instances/:id/unblock-cloud', async (req: Request, res: Response) => {
  const inst = await prisma.instance.findUnique({ where: { instance_id: req.params.id } });
  if (!inst) { res.status(404).json({ success: false, error: 'Instance not found' }); return; }

  await prisma.instance.update({
    where: { instance_id: req.params.id },
    data:  { cloud_blocked: false, block_reason: '' },
  });
  res.json({ success: true, message: `Cloud sync restored for ${req.params.id}` });
});

// ── Request full resync from a POS instance ──────────────────────────────────
// Sets needs_resync = true. The POS sees this flag on its next pull-data call,
// automatically triggers full-resync + push without any user interaction needed.
// The flag is cleared by pull-data after it is delivered.
router.post('/instances/:id/request-resync', async (req: Request, res: Response) => {
  const inst = await prisma.instance.findUnique({ where: { instance_id: req.params.id } });
  if (!inst) { res.status(404).json({ success: false, error: 'Instance not found' }); return; }
  await prisma.instance.update({
    where: { instance_id: req.params.id },
    data:  { needs_resync: true },
  });
  res.json({ success: true, message: `Full resync requested for ${req.params.id}. Device will re-push all data on its next sync cycle.` });
});

// ── Data health check: count sales with missing GP data ───────────────────────
router.get('/instances/:id/data-health', async (req: Request, res: Response) => {
  const inst = await prisma.instance.findUnique({ where: { instance_id: req.params.id } });
  if (!inst) { res.status(404).json({ success: false, error: 'Instance not found' }); return; }

  const sales     = await parseEntityFromSync(req.params.id, 'sale');
  const saleItems = await parseEntityFromSync(req.params.id, 'sale_item');

  const totalSales   = sales.filter((s: any) => s.status !== 'Cancelled' && s.status !== 'cancelled').length;
  const itemsByTxn   = new Map<string, any[]>();
  for (const item of saleItems) {
    const sid = String(item.sale_id ?? '');
    if (!itemsByTxn.has(sid)) itemsByTxn.set(sid, []);
    itemsByTxn.get(sid)!.push(item);
  }

  let missingCostCount  = 0;
  let zeroItemsCount    = 0;
  for (const s of sales) {
    if (s.status === 'Cancelled' || s.status === 'cancelled') continue;
    const items = itemsByTxn.get(String(s.id ?? '')) ?? [];
    if (items.length === 0) { zeroItemsCount++; continue; }
    const hasNoCost = items.every((it: any) => {
      const cost = parseFloat(it.cost_price ?? it.cost ?? '0');
      return !cost || cost === 0;
    });
    if (hasNoCost) missingCostCount++;
  }

  const healthPct = totalSales > 0 ? Math.round(((totalSales - missingCostCount) / totalSales) * 100) : 100;
  res.json({
    success: true,
    data: {
      total_sales:       totalSales,
      missing_cost:      missingCostCount,
      zero_item_sales:   zeroItemsCount,
      health_pct:        healthPct,
      needs_repair:      missingCostCount > 0,
    },
  });
});

// ── Request GP repair from a POS instance ────────────────────────────────────
// Triggers needs_resync so the POS re-pushes after the operator runs repair manually.
// The POS operator must go to Settings → Repair GP Data first, then this resync
// will push the corrected cost data to the cloud.
router.post('/instances/:id/request-gp-repair', async (req: Request, res: Response) => {
  const inst = await prisma.instance.findUnique({ where: { instance_id: req.params.id } });
  if (!inst) { res.status(404).json({ success: false, error: 'Instance not found' }); return; }
  await prisma.instance.update({
    where: { instance_id: req.params.id },
    data:  { needs_resync: true },
  });
  res.json({ success: true, message: 'Full resync requested. Ask the shop operator to run Settings → Repair GP Data on the POS, then sync.' });
});

// ── Issue / renew a license (works even when expired or blocked) ──────────────
// Body: { plan: 'lifetime' | 'monthly' | 'weekly' | 'custom', days?: number }
// 'lifetime' → null expiry; 'monthly' → 30d; 'weekly' → 7d; 'custom' → days param
router.post('/instances/:id/issue-license', async (req: Request, res: Response) => {
  try {
    const { plan, days: customDays } = req.body as { plan?: string; days?: number };
    if (!plan) { res.status(400).json({ success: false, error: 'plan is required' }); return; }

    const inst = await prisma.instance.findUnique({ where: { instance_id: req.params.id } });
    if (!inst) { res.status(404).json({ success: false, error: 'Instance not found' }); return; }

    const planDaysMap: Record<string, number> = { monthly: 30, weekly: 7, lifetime: 36500 };
    const durationDays = plan === 'lifetime' ? 36500
      : plan === 'custom' ? (Number(customDays) || 30)
      : (planDaysMap[plan] || 30);

    const issuedTo = (inst.store_name || inst.business_name || '').trim() || 'Unknown Business';
    const generated = generateLicenseKey({ issuedTo, fingerprint: '', plan, durationDays });

    await prisma.licenseKey.create({
      data: { license_key: generated.licenseKey, instance_id: req.params.id, plan, duration_days: durationDays, expires_at: generated.expiresAt, notes: 'Issued via admin panel' },
    });

    await prisma.instance.update({
      where: { instance_id: req.params.id },
      data: {
        license_key:     generated.licenseKey,
        license_plan:    plan,
        license_expiry:  generated.expiresAt,
        license_revoked: 0,
        approval_status: 'approved',
        block_reason:    '',
      },
    });

    res.json({ success: true, license_key: generated.licenseKey, plan, expires_at: generated.expiresAt });
  } catch (e: any) {
    console.error('[issue-license]', e.message);
    res.status(500).json({ success: false, error: e.message || 'Failed to issue license' });
  }
});

// ── Legacy: block instance (kept for backward-compat, now behaves like block-cloud) ──
router.post('/instances/:id/block', async (req: Request, res: Response) => {
  const { reason } = req.body as { reason?: string };
  const inst = await prisma.instance.findUnique({ where: { instance_id: req.params.id } });
  if (!inst) { res.status(404).json({ success: false, error: 'Instance not found' }); return; }

  await prisma.instance.update({
    where: { instance_id: req.params.id },
    data:  { cloud_blocked: true, block_reason: reason || 'Cloud sync suspended by admin' },
  });
  res.json({ success: true, message: `Instance ${req.params.id} cloud-blocked (legacy endpoint)` });
});

// ── DB Upload Request — Approve / Reject ──────────────────────────────────────
/**
 * POST /api/admin/instances/:id/approve-db-upload
 * Grants the store owner permission to upload their full POS database.
 */
router.post('/instances/:id/approve-db-upload', async (req: Request, res: Response) => {
  const inst = await prisma.instance.findUnique({ where: { instance_id: req.params.id } });
  if (!inst) { res.status(404).json({ success: false, error: 'Instance not found' }); return; }

  await prisma.instance.update({
    where: { instance_id: req.params.id },
    data:  { db_upload_status: 'approved' } as any,
  });

  res.json({ success: true, message: 'Database upload approved. The store owner can now proceed.' });
});

/**
 * POST /api/admin/instances/:id/reject-db-upload
 * Body: { reason?: string }
 */
router.post('/instances/:id/reject-db-upload', async (req: Request, res: Response) => {
  const { reason } = req.body as { reason?: string };
  const inst = await prisma.instance.findUnique({ where: { instance_id: req.params.id } });
  if (!inst) { res.status(404).json({ success: false, error: 'Instance not found' }); return; }

  await prisma.instance.update({
    where: { instance_id: req.params.id },
    data:  {
      db_upload_status: 'rejected',
      db_upload_note:   reason || 'Upload request rejected by admin.',
    } as any,
  });

  res.json({ success: true, message: 'Database upload request rejected.' });
});

// ── Mobile Access Toggle ───────────────────────────────────────────────────────
/**
 * POST /api/admin/instances/:id/mobile-access
 * Body: { enabled: boolean }
 *
 * Enables or disables mobile app access for a store.
 * When enabled, the POS app (using its api_key) can call
 * POST /api/instances/mobile-token to get a long-lived mobile JWT.
 * That JWT is saved in POS settings and shown to the store owner.
 */
router.post('/instances/:id/mobile-access', async (req: Request, res: Response) => {
  const { enabled } = req.body as { enabled: boolean };
  const inst = await prisma.instance.findUnique({ where: { instance_id: req.params.id } });
  if (!inst) { res.status(404).json({ success: false, error: 'Instance not found' }); return; }

  await prisma.instance.update({
    where: { instance_id: req.params.id },
    data:  { mobile_access: !!enabled },
  });

  res.json({
    success: true,
    mobile_access: !!enabled,
    message: enabled
      ? 'Mobile access enabled. The store owner can now get a mobile token from their POS app.'
      : 'Mobile access disabled. Existing mobile tokens will be rejected.',
  });
});

// ── Instance sales ─────────────────────────────────────────────────────────────
router.get('/instances/:id/sales', async (req: Request, res: Response) => {
  const { limit = '500', offset = '0', date_from, date_to } = req.query as Record<string, string>;
  const hasDateFilter = !!(date_from && date_to);

  const where: Prisma.InstanceSaleWhereInput = { instance_id: req.params.id };
  if (hasDateFilter) {
    where.date_created = { gte: date_from, lt: nextDayStr(date_to) };
  }

  const [sales, total] = await Promise.all([
    prisma.instanceSale.findMany({
      where,
      orderBy: { date_created: 'desc' },
      take:    Number(limit),
      skip:    Number(offset),
    }),
    prisma.instanceSale.count({ where }),
  ]);

  res.json({ success: true, data: sales, total });
});

// ── Instance export ────────────────────────────────────────────────────────────
router.get('/instances/:id/export', async (req: Request, res: Response) => {
  const instance = await prisma.instance.findUnique({ where: { instance_id: req.params.id } });
  if (!instance) { res.status(404).json({ success: false, error: 'Instance not found' }); return; }

  const { exportPayload, rawEventsCount } = await buildExportPayload(req.params.id);
  res.json({
    exported_at: new Date().toISOString(),
    instance: { store_name: instance.store_name, owner_name: instance.owner_name, owner_mobile: instance.owner_mobile, license_plan: instance.license_plan, approval_status: instance.approval_status },
    ...exportPayload,
    raw_events_count: rawEventsCount,
  });
});

// ── Export all ─────────────────────────────────────────────────────────────────
router.get('/export-all', async (req: Request, res: Response) => {
  const { status } = req.query as { status?: string };
  const where: Prisma.InstanceWhereInput = status ? { approval_status: status } : {};
  const instances = await prisma.instance.findMany({ where, orderBy: { created_at: 'desc' } });

  const exportData = await Promise.all(instances.map(async (inst) => {
    const { exportPayload } = await buildExportPayload(inst.instance_id);
    return {
      instance: { instance_id: inst.instance_id, store_name: inst.store_name, owner_name: inst.owner_name, owner_mobile: inst.owner_mobile, license_plan: inst.license_plan, license_expiry: inst.license_expiry, approval_status: inst.approval_status, total_sales: inst.total_sales, total_revenue: inst.total_revenue, total_customers: inst.total_customers, total_products: inst.total_products },
      ...exportPayload,
    };
  }));

  res.json({ exported_at: new Date().toISOString(), total_instances: instances.length, instances: exportData });
});

// ── Category-specific export ──────────────────────────────────────────────────
/**
 * GET /api/admin/instances/:id/export-category?cat=products
 *
 * Returns all synced data for a specific category as a structured JSON object.
 * The admin can call this for each category and download the result.
 */
const CATEGORY_ENTITIES: Record<string, string[]> = {
  products:  ['product', 'inventory_batch', 'stock_adjustment'],
  sales:     ['sale', 'sale_item'],
  customers: ['customer'],
  vendors:   ['vendor'],
  purchases: ['purchase', 'inventory_batch', 'purchase_return', 'purchase_return_item'],
  returns:   ['sale_return', 'sale_return_item', 'purchase_return', 'purchase_return_item'],
  loans:     ['customer_payment', 'vendor_payment'],
  accounts:  ['account', 'account_txn', 'register', 'financial_transaction'],
  expenses:  ['expense', 'employee', 'employee_advance'],
  settings:  ['settings'],
};

// entity_type → table name mapping (singular → plural)
const ENTITY_TABLE: Record<string, string> = {
  product: 'products', inventory_batch: 'inventory_batches', stock_adjustment: 'stock_adjustments',
  sale: 'sales', sale_item: 'sale_items',
  customer: 'customers', vendor: 'vendors', employee: 'employees', employee_advance: 'employee_advances',
  purchase: 'purchases', purchase_return: 'purchase_returns', purchase_return_item: 'purchase_return_items',
  sale_return: 'sale_returns', sale_return_item: 'sale_return_items',
  customer_payment: 'customer_payments', vendor_payment: 'vendor_payments',
  account: 'accounts', account_txn: 'account_txns', register: 'registers',
  financial_transaction: 'financial_transactions', settings: 'settings', entity_history: 'entity_history',
};

router.get('/instances/:id/export-category', async (req: Request, res: Response) => {
  const cat = String(req.query.cat || '');
  const entityTypes = CATEGORY_ENTITIES[cat];
  if (!entityTypes) {
    res.status(400).json({ success: false, error: `Unknown category "${cat}". Valid: ${Object.keys(CATEGORY_ENTITIES).join(', ')}` });
    return;
  }

  const exists = await prisma.instance.findUnique({ where: { instance_id: req.params.id }, select: { id: true, store_name: true } });
  if (!exists) { res.status(404).json({ success: false, error: 'Instance not found' }); return; }

  // Fetch all events for this instance that match the category's entity types
  const events = await prisma.syncEvent.findMany({
    where: { instance_id: req.params.id, entity_type: { in: entityTypes } },
    orderBy: { id: 'asc' },
  });

  // Deduplicate — latest wins, deletes remove the entry
  const entityMap: Record<string, Map<string, any>> = {};
  for (const ev of events) {
    const type = ev.entity_type;
    if (!entityMap[type]) entityMap[type] = new Map();
    let payload: any = null;
    try { payload = JSON.parse(ev.payload); } catch { continue; }
    if (!payload) continue;
    const key = String(payload?.id ?? payload?.barcode ?? ev.id);
    if (ev.operation === 'delete') entityMap[type].delete(key);
    else entityMap[type].set(key, payload);
  }

  // Build response with table names as keys
  const result: Record<string, any[]> = {};
  for (const entityType of entityTypes) {
    const tableName = ENTITY_TABLE[entityType] || entityType;
    result[tableName] = Array.from((entityMap[entityType] ?? new Map()).values());
  }

  res.json({
    success:      true,
    category:     cat,
    instance_id:  req.params.id,
    store_name:   exists.store_name,
    exported_at:  new Date().toISOString(),
    data:         result,
    record_count: Object.values(result).reduce((s, v) => s + v.length, 0),
  });
});

// ── Instance Settings (synced store config) ───────────────────────────────────
router.get('/instances/:id/settings', async (req: Request, res: Response) => {
  const instance = await prisma.instance.findUnique({ where: { instance_id: req.params.id } });
  if (!instance) { res.status(404).json({ success: false, error: 'Instance not found' }); return; }

  // Prefer settings synced via full-resync (entity_type='settings') for full detail
  const settingsEvents = await parseEntityFromSync(req.params.id, 'settings');
  const syncedSettings: any = settingsEvents[0] ?? null;

  const MODULE_KEYS = [
    'dms', 'wholesale', 'pharmacy', 'accounting', 'attendance', 'bakery',
    'grocery', 'restaurant', 'clothing', 'electronics', 'accessories',
    'dry_fruits', 'paint', 'mobile', 'laptop', 'urdu', 'product_images',
  ];
  const modules: Record<string, boolean> = {};
  // First try synced settings; then fall back to instance.active_modules from heartbeat
  for (const m of MODULE_KEYS) {
    const key = m === 'product_images' ? 'product_images_enabled' : `${m}_module_enabled`;
    modules[m] = !!(syncedSettings?.[key] ?? 0);
  }
  // If no synced settings yet, populate from active_modules heartbeat string
  if (!syncedSettings) {
    const rawStr: string = (instance as any).active_modules || '';
    if (rawStr.trim()) {
      rawStr.split(',').map((s: string) => s.trim()).filter(Boolean).forEach((m: string) => { modules[m] = true; });
    }
  }
  const enabledModules = MODULE_KEYS.filter(m => modules[m]);

  res.json({
    success: true,
    data: {
      // ── From instance registration / approval ─────────────────────────────
      store_name:      syncedSettings?.store_name      || instance.store_name,
      owner_name:      syncedSettings?.owner_full_name || instance.owner_name,
      owner_mobile:    syncedSettings?.owner_mobile    || instance.owner_mobile,
      owner_email:     syncedSettings?.owner_email     || instance.owner_email,
      store_address:   syncedSettings?.store_address   || instance.store_address,
      business_name:   syncedSettings?.business_name   || instance.business_name,
      // ── From synced settings ──────────────────────────────────────────────
      store_phone:       syncedSettings?.store_phone     || instance.owner_mobile || null,
      receipt_footer:    syncedSettings?.receipt_footer  || null,
      currency:          syncedSettings?.currency        || 'PKR',
      tax_rate:          syncedSettings?.tax_rate        ?? null,
      low_stock_threshold: syncedSettings?.low_stock_threshold ?? null,
      invoice_style:     syncedSettings?.invoice_style   || null,
      receipt_size:      syncedSettings?.receipt_size    || null,
      receipt_printer:   syncedSettings?.receipt_printer || null,
      label_printer:     syncedSettings?.label_printer   || null,
      // ── License & version ────────────────────────────────────────────────
      branch_name:     instance.branch_name,
      license_plan:    instance.license_plan,
      license_expiry:  instance.license_expiry,
      app_version:     instance.app_version,
      last_seen:       instance.last_seen,
      synced_from_pos: !!syncedSettings,
      // ── Modules ───────────────────────────────────────────────────────────
      modules,
      enabled_modules: enabledModules,
    },
  });
});

// ── Pagination helper ─────────────────────────────────────────────────────────
function paginate(arr: any[], page: number, limit: number) {
  const total  = arr.length;
  const pages  = Math.ceil(total / limit);
  const offset = (page - 1) * limit;
  return { data: arr.slice(offset, offset + limit), total, page, limit, pages };
}
function parsePage(q: Record<string, string>) {
  const limit = Math.min(500, Math.max(1, parseInt(q.limit ?? '') || 100));
  const page  = Math.max(1, parseInt(q.page  ?? '') || 1);
  return { limit, page };
}

// ── Products / customers / vendors / purchases / expenses / loans ──────────────
router.get('/instances/:id/products', async (req: Request, res: Response) => {
  const exists = await prisma.instance.findUnique({ where: { instance_id: req.params.id }, select: { id: true } });
  if (!exists) { res.status(404).json({ success: false, error: 'Instance not found' }); return; }
  const { limit, page } = parsePage(req.query as Record<string, string>);
  const all = (await parseEntityFromSync(req.params.id, 'product'))
    .map((product) => {
      const { stock, cost, salePrice } = normalizeProductStock(product);
      return { ...product, stock_value: Math.round(stock * cost * 100) / 100, retail_stock_value: Math.round(stock * salePrice * 100) / 100 };
    })
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  res.json({ success: true, ...paginate(all, page, limit) });
});

router.get('/instances/:id/customers', async (req: Request, res: Response) => {
  const exists = await prisma.instance.findUnique({ where: { instance_id: req.params.id }, select: { id: true } });
  if (!exists) { res.status(404).json({ success: false, error: 'Instance not found' }); return; }
  const { limit, page } = parsePage(req.query as Record<string, string>);

  // Computed live from synced sales/payments/returns — a stored outstanding_balance goes stale
  // whenever the POS recomputes without re-queuing the customer row.
  const [customers, sales, payments, saleReturns, accountTxns, khatas, khataPayments] = await Promise.all([
    parseEntityFromSync(req.params.id, 'customer'),
    parseEntityFromSync(req.params.id, 'sale'),
    parseEntityFromSync(req.params.id, 'customer_payment'),
    parseEntityFromSync(req.params.id, 'sale_return'),
    parseEntityFromSync(req.params.id, 'account_txn'),
    parseEntityFromSync(req.params.id, 'customer_khata'),
    parseEntityFromSync(req.params.id, 'customer_khata_payment'),
  ]);
  const invoiceBal = customerInvoiceBalances(sales, payments, saleReturns, accountTxns);
  const khataBal = khataBalancesBy(khatas, khataPayments, 'customer_id');

  const items = customers
    .map((c: any) => {
      const cid = String(c.id ?? '');
      const inv = invoiceBal.get(cid) ?? 0;
      const kh = khataBal.get(cid) ?? 0;
      return { ...c, invoice_balance: Math.round(inv * 100) / 100, khata_balance: Math.round(kh * 100) / 100, balance: Math.round((inv + kh) * 100) / 100 };
    })
    .sort((a: any, b: any) => (b.balance - a.balance) || (a.name || '').localeCompare(b.name || ''));

  res.json({ success: true, ...paginate(items, page, limit) });
});

router.get('/instances/:id/vendors', async (req: Request, res: Response) => {
  const exists = await prisma.instance.findUnique({ where: { instance_id: req.params.id }, select: { id: true } });
  if (!exists) { res.status(404).json({ success: false, error: 'Instance not found' }); return; }
  const { limit, page } = parsePage(req.query as Record<string, string>);

  const [vendors, purchases, payments, purchaseReturns, vendorKhatas, vendorKhataPayments] = await Promise.all([
    parseEntityFromSync(req.params.id, 'vendor'),
    parseEntityFromSync(req.params.id, 'purchase'),
    parseEntityFromSync(req.params.id, 'vendor_payment'),
    parseEntityFromSync(req.params.id, 'purchase_return'),
    parseEntityFromSync(req.params.id, 'vendor_khata'),
    parseEntityFromSync(req.params.id, 'vendor_khata_payment'),
  ]);

  const purchBal = vendorPurchaseBalances(purchases, payments, purchaseReturns);
  const khataMap = khataBalancesBy(vendorKhatas, vendorKhataPayments, 'vendor_id');

  const items = vendors.map((v: any) => {
    const vid = String(v.id ?? '');
    const pb = purchBal.get(vid) ?? 0;
    const kb = khataMap.get(vid) ?? 0;
    return {
      ...v,
      purchase_balance: Math.round(pb * 100) / 100,
      khata_balance:    Math.round(kb * 100) / 100,
      balance:          Math.round(Math.max(0, pb + kb) * 100) / 100,
    };
  }).sort((a: any, b: any) => (b.balance - a.balance) || (a.name || '').localeCompare(b.name || ''));

  res.json({ success: true, ...paginate(items, page, limit) });
});

// ── Period Stats (revenue + gross profit for a date range) ───────────────────
router.get('/instances/:id/period-stats', async (req: Request, res: Response) => {
  const exists = await prisma.instance.findUnique({ where: { instance_id: req.params.id }, select: { id: true } });
  if (!exists) { res.status(404).json({ success: false, error: 'Instance not found' }); return; }

  const { from, to, local_today } = req.query as { from?: string; to?: string; local_today?: string };

  // Compute previous period date range (same duration, shifted back)
  let prevFrom: string | undefined;
  let prevTo:   string | undefined;
  if (from && to) {
    const msFrom = new Date(from).getTime();
    const msTo   = new Date(to).getTime();
    const dur    = msTo - msFrom + 86400000; // inclusive days in ms
    prevTo   = new Date(msFrom - 86400000).toISOString().slice(0, 10);
    prevFrom = new Date(msFrom - dur).toISOString().slice(0, 10);
  }

  // Use client-supplied local date so "today" matches POS localtime (UTC+5 for Pakistan)
  const todayStr = (local_today && /^\d{4}-\d{2}-\d{2}$/.test(local_today)) ? local_today : pkToday();
  const todayMs  = new Date(todayStr).getTime();
  const ystStr   = new Date(todayMs - 86400000).toISOString().slice(0, 10);

  const [sales, saleItems, custPayments, purchases, expenses, saleReturns, saleReturnItems, purchaseReturns] = await Promise.all([
    parseEntityFromSync(req.params.id, 'sale'),
    parseEntityFromSync(req.params.id, 'sale_item'),
    parseEntityFromSync(req.params.id, 'customer_payment'),
    parseEntityFromSync(req.params.id, 'purchase'),
    parseEntityFromSync(req.params.id, 'expense'),
    parseEntityFromSync(req.params.id, 'sale_return'),
    parseEntityFromSync(req.params.id, 'sale_return_item'),
    parseEntityFromSync(req.params.id, 'purchase_return'),
  ]);

  const dateOf = (e: any): string | null => posDay(e.date_created || e.date_added || e.date || null);

  const inRange = (d: string | null, f?: string, t?: string): boolean => {
    if (!d) return false;
    if (f && d < f) return false;
    if (t && d > t) return false;
    return true;
  };

  // Desktop P&L rules: active (completed/paid/partial) sales in range, net of returns on those
  // sales, COGS on net quantity — so the cloud figure matches the POS report exactly.
  const cur = salesPnl(sales, saleItems, saleReturns, saleReturnItems, (s: any) => inRange(dateOf(s), from, to));
  const filtSales = cur.kept;
  const revenue = cur.revenue;
  const cogs    = cur.cogs;
  const hasGP   = cur.itemsWithCost > 0;
  const gp      = hasGP ? revenue - cogs : null;

  const cashCollected   = custPayments.filter((p: any) => inRange(dateOf(p), from, to)).reduce((s: number, p: any) => s + toNumber(p.amount), 0);

  // Purchase returns in period reduce period purchases; cancelled purchases count nothing
  const liveAllPurchases = purchases.filter((p: any) => !isCancelledRow(p));
  const livePurchaseIds = new Set(liveAllPurchases.map((p: any) => String(p.id)));
  const returnedPurchaseAmt = purchaseReturns
    .filter((r: any) => inRange(dateOf(r), from, to) && livePurchaseIds.has(String(r.purchase_id)))
    .reduce((s: number, r: any) => s + toNumber(r.total_returned), 0);
  const periodPurchases = liveAllPurchases.filter((p: any) => inRange(dateOf(p), from, to)).reduce((s: number, p: any) => s + toNumber(p.total), 0) - returnedPurchaseAmt;
  const periodExpenses  = expenses.filter((e: any) => inRange(dateOf(e), from, to)).reduce((s: number, e: any) => s + toNumber(e.amount), 0);

  // Previous period (for % change)
  const prev = prevFrom ? salesPnl(sales, saleItems, saleReturns, saleReturnItems, (s: any) => inRange(dateOf(s), prevFrom, prevTo)) : null;
  const prevRevenue      = prev?.revenue ?? 0;
  const prevTransactions = prev?.count ?? 0;
  const prevGP           = prev && prev.itemsWithCost > 0 ? prev.revenue - prev.cogs : null;

  const pct = (cur: number, prev: number): number | null =>
    prev > 0 ? Math.round((cur - prev) / prev * 1000) / 10 : null;

  // Today vs yesterday
  const todayRevenue = salesPnl(sales, saleItems, saleReturns, saleReturnItems, (s: any) => dateOf(s) === todayStr).revenue;
  const ystRevenue   = salesPnl(sales, saleItems, saleReturns, saleReturnItems, (s: any) => dateOf(s) === ystStr).revenue;

  const rnd = (v: number) => Math.round(v * 100) / 100;

  res.json({
    success: true,
    data: {
      revenue:          rnd(revenue),
      gross_profit:     gp !== null ? rnd(gp) : null,
      cogs:             hasGP ? rnd(cogs) : null,
      transactions:     filtSales.length,
      avg_transaction:  filtSales.length > 0 ? rnd(revenue / filtSales.length) : 0,
      has_cost_data:    hasGP,
      // Extended stats
      cash_collected:   rnd(cashCollected),
      period_purchases: rnd(periodPurchases),
      period_expenses:  rnd(periodExpenses),
      net_profit:       gp !== null ? rnd(gp - periodExpenses) : null,
      // Today
      today_revenue:    rnd(todayRevenue),
      yesterday_revenue: rnd(ystRevenue),
      today_pct_change: pct(todayRevenue, ystRevenue),
      // Previous period % change
      revenue_pct_change:      pct(revenue, prevRevenue),
      transactions_pct_change: pct(filtSales.length, prevTransactions),
      profit_pct_change:       (gp !== null && prevGP !== null) ? pct(gp, prevGP) : null,
      prev_revenue:    rnd(prevRevenue),
      prev_profit:     prevGP !== null ? rnd(prevGP) : null,
      prev_transactions: prevTransactions,
    },
  });
});

// ── Customer ledger (sales + payments for a specific customer) ───────────────
router.get('/instances/:id/customers/:cid/ledger', async (req: Request, res: Response) => {
  const { id, cid } = req.params;
  const exists = await prisma.instance.findUnique({ where: { instance_id: id }, select: { id: true } });
  if (!exists) { res.status(404).json({ success: false, error: 'Instance not found' }); return; }

  const [customers, sales, payments, khataEntries, khataPayments, saleReturns, accountTxns] = await Promise.all([
    parseEntityFromSync(id, 'customer'),
    parseEntityFromSync(id, 'sale'),
    parseEntityFromSync(id, 'customer_payment'),
    parseEntityFromSync(id, 'customer_khata'),
    parseEntityFromSync(id, 'customer_khata_payment'),
    parseEntityFromSync(id, 'sale_return'),
    parseEntityFromSync(id, 'account_txn'),
  ]);

  const customer = customers.find((c: any) => String(c.id) === cid);
  if (!customer) { res.status(404).json({ success: false, error: 'Customer not found' }); return; }

  type Row = { id: any; entry_id: string; date: string | null; type: string; description: string; debit: number; credit: number; payment_method: string | null; status: string | null };
  const custSalesRaw = sales.filter((s: any) => String(s.customer_id) === cid && !isCancelledRow(s));
  const custSaleIds = new Set(custSalesRaw.map((s: any) => String(s.id)));

  const customerSales: Row[] = [];
  for (const s of custSalesRaw) {
    const date = s.date_created || s.date_added || s.date || null;
    customerSales.push({
      id: s.id, entry_id: `sale-${s.id}`, date, type: 'sale',
      description: `Sale #${s.id}`, debit: toNumber(s.total), credit: 0,
      payment_method: s.payment_method || null, status: s.status || null,
    });
    const wo = toNumber(s.write_off_amount);
    if (wo > 0) customerSales.push({
      id: s.id, entry_id: `writeoff-${s.id}`, date, type: 'write_off',
      description: `Write-off on Sale #${s.id}`, debit: 0, credit: wo, payment_method: null, status: null,
    });
  }

  // Returns credit the customer; cash handed back on a return cancels that credit (desktop rule).
  const refunded = refundsBySale(saleReturns, accountTxns);
  const returnRows: Row[] = [];
  for (const r of saleReturns) {
    if (!custSaleIds.has(String(r.sale_id))) continue;
    returnRows.push({
      id: r.id, entry_id: `ret-${r.id}`, date: r.date_created || r.date || null, type: 'return',
      description: `Return on Sale #${r.sale_id}`, debit: 0, credit: toNumber(r.total_returned), payment_method: null, status: null,
    });
  }
  for (const [sid, amt] of refunded) {
    if (!custSaleIds.has(sid) || amt <= 0) continue;
    const lastRet = saleReturns.filter((r: any) => String(r.sale_id) === sid).map((r: any) => r.date_created || '').sort().pop() || null;
    returnRows.push({
      id: sid, entry_id: `refund-${sid}`, date: lastRet, type: 'refund',
      description: `Cash refunded for Sale #${sid}`, debit: amt, credit: 0, payment_method: 'cash', status: null,
    });
  }

  const customerPayments: Row[] = payments
    .filter((p: any) => String(p.customer_id) === cid)
    .map((p: any) => ({
      id: p.id, entry_id: `pay-${p.id}`,
      date: p.date_added || p.date_created || p.date || null,
      type: 'payment',
      description: p.notes || p.note || p.description || 'Payment',
      debit: 0,
      credit: toNumber(p.amount),
      payment_method: p.payment_method || null,
      status: null,
    }));

  const customerKhata = khataEntries
    .filter((k: any) => String(k.customer_id) === cid)
    .map((k: any) => ({
      id: k.id, entry_id: `khata-${k.id}`,
      date: k.date_created || k.date_added || k.date || null,
      type: 'khata_bill' as const,
      description: k.title || `Custom Bill #${k.id}`,
      debit: parseFloat(k.total_amount) || 0,
      credit: 0,
      payment_method: null,
      status: null,
    }));

  // Build set of open khata IDs belonging to this customer (closed bills don't count, as on the desktop)
  const custKhataIds = new Set(khataEntries.filter((k: any) => String(k.customer_id) === cid && lc(k.status) !== 'closed').map((k: any) => String(k.id)));
  const customerKhataPayments = khataPayments
    .filter((p: any) => custKhataIds.has(String(p.khata_id)))
    .map((p: any) => ({
      id: p.id, entry_id: `khatapay-${p.id}`,
      date: p.date_created || p.date_added || p.date || null,
      type: 'khata_payment' as const,
      description: p.note || 'Khata Payment',
      debit: 0,
      credit: parseFloat(p.amount) || 0,
      payment_method: null,
      status: null,
    }));

  const ledger = [...customerSales, ...returnRows, ...customerPayments, ...customerKhata.filter((k: any) => custKhataIds.has(String(k.id))), ...customerKhataPayments]
    .sort((a, b) => (posDay(a.date) || '').localeCompare(posDay(b.date) || '') || String(a.date || '').localeCompare(String(b.date || '')));

  let running = 0;
  const ledgerWithBalance = ledger.map(row => {
    running = Math.round((running + row.debit - row.credit) * 100) / 100;
    return { ...row, running_balance: running };
  });

  const sumDebit  = (rows: Row[]) => rows.reduce((s, r) => s + r.debit, 0);
  const sumCredit = (rows: Row[]) => rows.reduce((s, r) => s + r.credit, 0);
  const openKhata = customerKhata.filter((k: any) => custKhataIds.has(String(k.id)));
  // Same formula as the customer list / desktop: invoice balance (floored at 0) + open custom bills.
  const invoiceOutstanding = customerInvoiceBalances(sales, payments, saleReturns, accountTxns).get(cid) ?? 0;
  const khataOutstanding = khataBalancesBy(khataEntries, khataPayments, 'customer_id').get(cid) ?? 0;

  res.json({
    success: true,
    data: {
      customer,
      ledger: ledgerWithBalance,
      summary: {
        total_sales:  Math.round((sumDebit(customerSales) + sumDebit(openKhata)) * 100) / 100,
        total_paid:   Math.round((sumCredit(customerPayments) + sumCredit(customerKhataPayments)) * 100) / 100,
        total_returned: Math.round((sumCredit(returnRows) - sumDebit(returnRows)) * 100) / 100,
        outstanding:  Math.round((invoiceOutstanding + khataOutstanding) * 100) / 100,
      },
    },
  });
});

// ── Vendor ledger (purchases + payments for a specific vendor) ───────────────
router.get('/instances/:id/vendors/:vid/ledger', async (req: Request, res: Response) => {
  const { id, vid } = req.params;
  const exists = await prisma.instance.findUnique({ where: { instance_id: id }, select: { id: true } });
  if (!exists) { res.status(404).json({ success: false, error: 'Instance not found' }); return; }

  const [vendors, purchases, payments, khataEntries, khataPayments, purchaseReturns] = await Promise.all([
    parseEntityFromSync(id, 'vendor'),
    parseEntityFromSync(id, 'purchase'),
    parseEntityFromSync(id, 'vendor_payment'),
    parseEntityFromSync(id, 'vendor_khata'),
    parseEntityFromSync(id, 'vendor_khata_payment'),
    parseEntityFromSync(id, 'purchase_return'),
  ]);

  const vendor = vendors.find((v: any) => String(v.id) === vid);
  if (!vendor) { res.status(404).json({ success: false, error: 'Vendor not found' }); return; }

  // Cancelled purchases (and payments tied to them) count nothing — desktop rule.
  const cancelledPurchaseIds = new Set(purchases.filter((p: any) => isCancelledRow(p)).map((p: any) => String(p.id)));
  const vendorReturns = purchaseReturns
    .filter((r: any) => {
      const p = purchases.find((x: any) => String(x.id) === String(r.purchase_id));
      return p && String(p.vendor_id) === vid && !cancelledPurchaseIds.has(String(p.id));
    })
    .map((r: any) => ({
      id: r.id, entry_id: `ret-${r.id}`,
      date: r.date_created || r.date || null,
      type: 'return' as const,
      description: `Return on Purchase #${r.purchase_id}`,
      debit: 0,
      credit: toNumber(r.total_returned),
      payment_method: null as string | null,
      status: null as string | null,
    }));

  const vendorPurchases = purchases
    .filter((p: any) => String(p.vendor_id) === vid && !isCancelledRow(p))
    .map((p: any) => ({
      id: p.id, entry_id: `pur-${p.id}`,
      date: p.date_created || p.date_added || p.date || null,
      type: 'purchase' as const,
      description: `Purchase #${p.id}${p.bill_no ? ` (${p.bill_no})` : ''}`,
      debit: parseFloat(p.total) || 0,
      credit: 0,
      payment_method: p.payment_method || null,
      status: p.status || null,
    }));

  const vendorPayments = payments
    .filter((p: any) => String(p.vendor_id) === vid && !cancelledPurchaseIds.has(String(p.purchase_id ?? '')))
    .map((p: any) => ({
      id: p.id, entry_id: `pay-${p.id}`,
      date: p.date_created || p.date_added || p.date || null,
      type: 'payment' as const,
      description: p.notes || p.note || p.description || 'Payment',
      debit: 0,
      credit: parseFloat(p.amount) || 0,
      payment_method: p.payment_method || null,
      status: null,
    }));

  const vendorKhata = khataEntries
    .filter((k: any) => String(k.vendor_id) === vid && lc(k.status) !== 'closed')
    .map((k: any) => ({
      id: k.id, entry_id: `khata-${k.id}`,
      date: k.date_created || k.date_added || k.date || null,
      type: 'khata_bill' as const,
      description: k.title || `Custom Bill #${k.id}`,
      debit: parseFloat(k.total_amount) || 0,
      credit: 0,
      payment_method: null,
      status: null,
    }));

  const vendKhataIds = new Set(vendorKhata.map((k: any) => String(k.id)));
  const vendorKhataPayments = khataPayments
    .filter((p: any) => vendKhataIds.has(String(p.khata_id)))
    .map((p: any) => ({
      id: p.id, entry_id: `khatapay-${p.id}`,
      date: p.date_created || p.date_added || p.date || null,
      type: 'khata_payment' as const,
      description: p.note || 'Khata Payment',
      debit: 0,
      credit: parseFloat(p.amount) || 0,
      payment_method: null,
      status: null,
    }));

  const ledger = [...vendorPurchases, ...vendorReturns, ...vendorPayments, ...vendorKhata, ...vendorKhataPayments]
    .sort((a, b) => (posDay(a.date) || '').localeCompare(posDay(b.date) || '') || String(a.date || '').localeCompare(String(b.date || '')));

  let running = 0;
  const ledgerWithBalance = ledger.map(row => {
    running = Math.round((running + row.debit - row.credit) * 100) / 100;
    return { ...row, running_balance: running };
  });

  const totalPurchases  = vendorPurchases.reduce((s, r) => s + r.debit, 0);
  const totalPaid       = vendorPayments.reduce((s, r) => s + r.credit, 0);
  const totalKhata      = vendorKhata.reduce((s, r) => s + r.debit, 0);
  const totalKhataPaid  = vendorKhataPayments.reduce((s, r) => s + r.credit, 0);
  const totalReturned   = vendorReturns.reduce((s, r) => s + r.credit, 0);
  // Same formula as the vendor list / desktop get-vendors.
  const purchaseOutstanding = vendorPurchaseBalances(purchases, payments, purchaseReturns).get(vid) ?? 0;
  const khataOutstanding    = khataBalancesBy(khataEntries, khataPayments, 'vendor_id').get(vid) ?? 0;

  res.json({
    success: true,
    data: {
      vendor,
      ledger: ledgerWithBalance,
      summary: {
        total_purchases: Math.round((totalPurchases + totalKhata) * 100) / 100,
        total_paid:      Math.round((totalPaid + totalKhataPaid) * 100) / 100,
        total_returned:  Math.round(totalReturned * 100) / 100,
        outstanding:     Math.round(Math.max(0, purchaseOutstanding + khataOutstanding) * 100) / 100,
      },
    },
  });
});

router.get('/instances/:id/purchases', async (req: Request, res: Response) => {
  const exists = await prisma.instance.findUnique({ where: { instance_id: req.params.id }, select: { id: true } });
  if (!exists) { res.status(404).json({ success: false, error: 'Instance not found' }); return; }
  const { limit, page } = parsePage(req.query as Record<string, string>);

  const [purchases, vendors] = await Promise.all([
    parseEntityFromSync(req.params.id, 'purchase'),
    parseEntityFromSync(req.params.id, 'vendor'),
  ]);

  const vendorById = new Map<string, string>(vendors.map((v: any) => [String(v.id ?? ''), v.name || '—']));

  const all = purchases
    .map((p: any) => ({
      ...p,
      date:        p.date_created || p.date_added || p.date || null,
      vendor_name: vendorById.get(String(p.vendor_id ?? '')) || p.vendor_name || '—',
    }))
    .sort((a: any, b: any) => (b.date || '').localeCompare(a.date || ''));

  res.json({ success: true, ...paginate(all, page, limit) });
});

router.get('/instances/:id/expenses', async (req: Request, res: Response) => {
  const exists = await prisma.instance.findUnique({ where: { instance_id: req.params.id }, select: { id: true } });
  if (!exists) { res.status(404).json({ success: false, error: 'Instance not found' }); return; }
  const { limit, page } = parsePage(req.query as Record<string, string>);

  const [expenses, employees] = await Promise.all([
    parseEntityFromSync(req.params.id, 'expense'),
    parseEntityFromSync(req.params.id, 'employee'),
  ]);

  const expenseRows = expenses
    .map((e: any) => ({ ...e, _type: 'expense' }))
    .sort((a: any, b: any) => (b.date_added || b.date_created || '').localeCompare(a.date_added || a.date_created || ''));

  const employeeRows = employees
    .map((e: any) => ({ ...e, _type: 'employee' }))
    .sort((a: any, b: any) => (a.name || '').localeCompare(b.name || ''));

  res.json({ success: true, ...paginate(expenseRows, page, limit), employees: employeeRows, totalEmployees: employeeRows.length });
});

// ── Returns (sale returns + purchase returns) ─────────────────────────────────
router.get('/instances/:id/returns', async (req: Request, res: Response) => {
  const exists = await prisma.instance.findUnique({ where: { instance_id: req.params.id }, select: { id: true } });
  if (!exists) { res.status(404).json({ success: false, error: 'Instance not found' }); return; }
  const { limit, page } = parsePage(req.query as Record<string, string>);
  const [saleReturns, purchaseReturns, customers, vendors, sales, purchases] = await Promise.all([
    parseEntityFromSync(req.params.id, 'sale_return'),
    parseEntityFromSync(req.params.id, 'purchase_return'),
    parseEntityFromSync(req.params.id, 'customer'),
    parseEntityFromSync(req.params.id, 'vendor'),
    parseEntityFromSync(req.params.id, 'sale'),
    parseEntityFromSync(req.params.id, 'purchase'),
  ]);
  const custMap   = new Map(customers.map((c: any) => [String(c.id), c.name || '—']));
  const vendMap   = new Map(vendors.map((v: any)  => [String(v.id), v.name || '—']));
  // Map sale_id / purchase_id → customer/vendor id for returns that lack a direct FK
  const saleToCustomer    = new Map(sales.map((s: any)    => [String(s.id), String(s.customer_id ?? '')]));
  const purchaseToVendor  = new Map(purchases.map((p: any) => [String(p.id), String(p.vendor_id   ?? '')]));
  const sr = saleReturns.map((r: any) => {
    const custId = r.customer_id ? String(r.customer_id) : saleToCustomer.get(String(r.sale_id ?? '')) ?? '';
    return {
      ...r, _type: 'sale_return',
      party_name: custMap.get(custId) || r.customer_name || '—',
      amount: parseFloat(r.total_returned ?? r.total ?? r.amount ?? 0),
      date: r.date_created || r.date_added || r.date,
    };
  }).sort((a: any, b: any) => (b.date || '').localeCompare(a.date || ''));
  const pr = purchaseReturns.map((r: any) => {
    const vendId = r.vendor_id ? String(r.vendor_id) : purchaseToVendor.get(String(r.purchase_id ?? '')) ?? '';
    return {
      ...r, _type: 'purchase_return',
      party_name: vendMap.get(vendId) || r.vendor_name || '—',
      amount: parseFloat(r.total_returned ?? r.total ?? r.amount ?? 0),
      date: r.date_created || r.date_added || r.date,
    };
  }).sort((a: any, b: any) => (b.date || '').localeCompare(a.date || ''));
  const allReturns = [...sr, ...pr].sort((a: any, b: any) => (b.date || '').localeCompare(a.date || ''));
  res.json({ success: true, sale_returns: sr, purchase_returns: pr, ...paginate(allReturns, page, limit) });
});

// ── Stock Adjustments ─────────────────────────────────────────────────────────
router.get('/instances/:id/stock-adjustments', async (req: Request, res: Response) => {
  const exists = await prisma.instance.findUnique({ where: { instance_id: req.params.id }, select: { id: true } });
  if (!exists) { res.status(404).json({ success: false, error: 'Instance not found' }); return; }
  const { limit, page } = parsePage(req.query as Record<string, string>);
  const [adjustments, products] = await Promise.all([
    parseEntityFromSync(req.params.id, 'stock_adjustment'),
    parseEntityFromSync(req.params.id, 'product'),
  ]);
  const prodMap = new Map(products.map((p: any) => [String(p.id), p.name || '—']));
  const all = adjustments.map((a: any) => ({
    ...a,
    product_name: prodMap.get(String(a.product_id ?? '')) || a.product_name || '—',
    date: a.date_created || a.date_added || a.date,
  })).sort((a: any, b: any) => (b.date || '').localeCompare(a.date || ''));
  res.json({ success: true, ...paginate(all, page, limit) });
});

// ── Employee Advances ─────────────────────────────────────────────────────────
router.get('/instances/:id/employee-advances', async (req: Request, res: Response) => {
  const exists = await prisma.instance.findUnique({ where: { instance_id: req.params.id }, select: { id: true } });
  if (!exists) { res.status(404).json({ success: false, error: 'Instance not found' }); return; }
  const { limit, page } = parsePage(req.query as Record<string, string>);
  const [advances, employees] = await Promise.all([
    parseEntityFromSync(req.params.id, 'employee_advance'),
    parseEntityFromSync(req.params.id, 'employee'),
  ]);
  const empMap = new Map(employees.map((e: any) => [String(e.id), e.name || '—']));
  const all = advances.map((a: any) => ({
    ...a,
    employee_name: empMap.get(String(a.employee_id ?? '')) || a.employee_name || '—',
    date: a.date_created || a.date_added || a.date,
  })).sort((a: any, b: any) => (b.date || '').localeCompare(a.date || ''));
  res.json({ success: true, ...paginate(all, page, limit) });
});

// ── DMS (Delivery Management System) ─────────────────────────────────────────
router.get('/instances/:id/dms', async (req: Request, res: Response) => {
  const exists = await prisma.instance.findUnique({ where: { instance_id: req.params.id }, select: { id: true } });
  if (!exists) { res.status(404).json({ success: false, error: 'Instance not found' }); return; }
  const [companies, orders, recoveries, partnerships, drawings] = await Promise.all([
    parseEntityFromSync(req.params.id, 'dms_company'),
    parseEntityFromSync(req.params.id, 'dms_order'),
    parseEntityFromSync(req.params.id, 'dms_recovery'),
    parseEntityFromSync(req.params.id, 'dms_partnership'),
    parseEntityFromSync(req.params.id, 'dms_partner_drawing'),
  ]);
  res.json({ success: true, companies, orders, recoveries, partnerships, drawings });
});

// ── Accounts & Cash ────────────────────────────────────────────────────────────
router.get('/instances/:id/accounts', async (req: Request, res: Response) => {
  const exists = await prisma.instance.findUnique({ where: { instance_id: req.params.id }, select: { id: true } });
  if (!exists) { res.status(404).json({ success: false, error: 'Instance not found' }); return; }

  const [accounts, txns, registers] = await Promise.all([
    parseEntityFromSync(req.params.id, 'account'),
    parseEntityFromSync(req.params.id, 'account_txn'),
    parseEntityFromSync(req.params.id, 'register'),
  ]);

  // Compute current balance per account from txns
  const balanceMap = new Map<string, number>();
  for (const acc of accounts) {
    balanceMap.set(String(acc.id), parseFloat(acc.opening_balance) || 0);
  }
  for (const txn of txns) {
    const id = String(txn.account_id ?? '');
    if (!id) continue;
    const current = balanceMap.get(id) ?? 0;
    const amount  = parseFloat(txn.amount) || 0;
    balanceMap.set(id, current + (txn.type === 'in' ? amount : -amount));
  }

  const accountsWithBalance = accounts.map((acc: any) => ({
    ...acc,
    computed_balance: Math.round((balanceMap.get(String(acc.id)) ?? 0) * 100) / 100,
  }));

  res.json({
    success:   true,
    accounts:  accountsWithBalance,
    txns:      txns.sort((a: any, b: any) => (b.date_created || '').localeCompare(a.date_created || '')),
    registers: registers.sort((a: any, b: any) => (b.opened_at || '').localeCompare(a.opened_at || '')),
    totalBalance: Math.round(accountsWithBalance.reduce((s: number, a: any) => s + a.computed_balance, 0) * 100) / 100,
  });
});

router.get('/instances/:id/loans', async (req: Request, res: Response) => {
  const exists = await prisma.instance.findUnique({ where: { instance_id: req.params.id }, select: { id: true } });
  if (!exists) { res.status(404).json({ success: false, error: 'Instance not found' }); return; }

  const [customers, custKhata, custKhataPayments,
         vendors, purchases, vendorPayments, vendKhata, vendKhataPayments, purchaseReturns,
         sales, custPayments, saleReturns, accountTxns] = await Promise.all([
    parseEntityFromSync(req.params.id, 'customer'),
    parseEntityFromSync(req.params.id, 'customer_khata'),
    parseEntityFromSync(req.params.id, 'customer_khata_payment'),
    parseEntityFromSync(req.params.id, 'vendor'),
    parseEntityFromSync(req.params.id, 'purchase'),
    parseEntityFromSync(req.params.id, 'vendor_payment'),
    parseEntityFromSync(req.params.id, 'vendor_khata'),
    parseEntityFromSync(req.params.id, 'vendor_khata_payment'),
    parseEntityFromSync(req.params.id, 'purchase_return'),
    parseEntityFromSync(req.params.id, 'sale'),
    parseEntityFromSync(req.params.id, 'customer_payment'),
    parseEntityFromSync(req.params.id, 'sale_return'),
    parseEntityFromSync(req.params.id, 'account_txn'),
  ]);

  const invoiceBalByC = customerInvoiceBalances(sales, custPayments, saleReturns, accountTxns);
  const khataNetByC = khataBalancesBy(custKhata, custKhataPayments, 'customer_id');

  const customerLoans = customers
    .map((c: any) => {
      const cid = String(c.id ?? '');
      const salesBal = invoiceBalByC.get(cid) ?? 0;
      const khataBal = khataNetByC.get(cid) ?? 0;
      const balance  = salesBal + khataBal;
      return {
        ...c,
        customer_id:   c.id,
        customer_name: c.name || c.customer_name || '—',
        total_amount:  Math.round(balance * 100) / 100,
        paid_amount:   0,
        balance:       Math.round(balance * 100) / 100,
      };
    })
    .filter((c: any) => c.balance > 0)
    .sort((a: any, b: any) => b.balance - a.balance);

  // Desktop rule: cancelled purchases count nothing; payments tied to a purchase only offset that purchase.
  const purchBalByV = vendorPurchaseBalances(purchases, vendorPayments, purchaseReturns);
  const khataBalByV = khataBalancesBy(vendKhata, vendKhataPayments, 'vendor_id');
  const purchTotalByV = new Map<string, number>();
  for (const p of purchases) {
    if (isCancelledRow(p)) continue;
    const vid = String(p.vendor_id ?? '');
    purchTotalByV.set(vid, (purchTotalByV.get(vid) ?? 0) + toNumber(p.total));
  }
  for (const k of vendKhata) {
    if (lc(k.status) === 'closed') continue;
    const vid = String(k.vendor_id ?? '');
    purchTotalByV.set(vid, (purchTotalByV.get(vid) ?? 0) + toNumber(k.total_amount));
  }

  const vendorLoans = vendors
    .map((v: any) => {
      const vid     = String(v.id ?? '');
      const total   = purchTotalByV.get(vid) ?? 0;
      const balance = Math.max(0, (purchBalByV.get(vid) ?? 0) + (khataBalByV.get(vid) ?? 0));
      return {
        ...v,
        vendor_id:    v.id,
        vendor_name:  v.name || v.vendor_name || '—',
        total_amount: Math.round(total * 100) / 100,
        paid_amount:  Math.round(Math.max(0, total - balance) * 100) / 100,
        balance:      Math.round(balance * 100) / 100,
      };
    })
    .filter((v: any) => v.balance > 0)
    .sort((a: any, b: any) => b.balance - a.balance);

  res.json({
    success: true,
    data: {
      customerLoans, vendorLoans,
      totalReceivable: Math.round(customerLoans.reduce((s: number, c: any) => s + c.balance, 0) * 100) / 100,
      totalPayable:    Math.round(vendorLoans.reduce((s: number, v: any) => s + v.balance, 0) * 100) / 100,
    },
  });
});

// ── Khata (customer + vendor custom bills) ────────────────────────────────────
router.get('/instances/:id/khata', async (req: Request, res: Response) => {
  const exists = await prisma.instance.findUnique({ where: { instance_id: req.params.id }, select: { id: true } });
  if (!exists) { res.status(404).json({ success: false, error: 'Instance not found' }); return; }

  const [customerKhata, khataPayments, customers, vendorKhata, vendorKhataPayments, vendors] = await Promise.all([
    parseEntityFromSync(req.params.id, 'customer_khata'),
    parseEntityFromSync(req.params.id, 'customer_khata_payment'),
    parseEntityFromSync(req.params.id, 'customer'),
    parseEntityFromSync(req.params.id, 'vendor_khata'),
    parseEntityFromSync(req.params.id, 'vendor_khata_payment'),
    parseEntityFromSync(req.params.id, 'vendor'),
  ]);

  const custMap = new Map(customers.map((c: any) => [String(c.id), c.name || '—']));
  const vendMap = new Map(vendors.map((v: any) => [String(v.id), v.name || '—']));

  const kPaidMap = new Map<string, number>();
  for (const p of khataPayments) {
    const kid = String(p.khata_id ?? '');
    if (!kid) continue;
    kPaidMap.set(kid, (kPaidMap.get(kid) ?? 0) + toNumber(p.amount));
  }
  const vkPaidMap = new Map<string, number>();
  for (const p of vendorKhataPayments) {
    const kid = String(p.khata_id ?? '');
    if (!kid) continue;
    vkPaidMap.set(kid, (vkPaidMap.get(kid) ?? 0) + toNumber(p.amount));
  }

  const customerBills = customerKhata.map((k: any) => {
    const paid = kPaidMap.get(String(k.id)) ?? 0;
    return { ...k, customer_name: custMap.get(String(k.customer_id)) ?? '—', paid_amount: paid, balance: Math.max(0, toNumber(k.total_amount) - paid) };
  }).sort((a: any, b: any) => b.balance - a.balance);

  const vendorBills = vendorKhata.map((k: any) => {
    const paid = vkPaidMap.get(String(k.id)) ?? 0;
    return { ...k, vendor_name: vendMap.get(String(k.vendor_id)) ?? '—', paid_amount: paid, balance: Math.max(0, toNumber(k.total_amount) - paid) };
  }).sort((a: any, b: any) => b.balance - a.balance);

  res.json({
    success: true,
    data: {
      customerBills,
      vendorBills,
      totalCustomerOwed: Math.round(customerBills.reduce((s: number, k: any) => s + k.balance, 0) * 100) / 100,
      totalVendorOwed:   Math.round(vendorBills.reduce((s: number, k: any) => s + k.balance, 0) * 100) / 100,
    },
  });
});

// ── Route Book ────────────────────────────────────────────────────────────────
router.get('/instances/:id/route-book', async (req: Request, res: Response) => {
  const exists = await prisma.instance.findUnique({ where: { instance_id: req.params.id }, select: { id: true } });
  if (!exists) { res.status(404).json({ success: false, error: 'Instance not found' }); return; }

  const [locations, members, customers, customerKhata, khataPayments, sales, custPayments, saleReturns, accountTxns] = await Promise.all([
    parseEntityFromSync(req.params.id, 'customer_location'),
    parseEntityFromSync(req.params.id, 'customer_location_member'),
    parseEntityFromSync(req.params.id, 'customer'),
    parseEntityFromSync(req.params.id, 'customer_khata'),
    parseEntityFromSync(req.params.id, 'customer_khata_payment'),
    parseEntityFromSync(req.params.id, 'sale'),
    parseEntityFromSync(req.params.id, 'customer_payment'),
    parseEntityFromSync(req.params.id, 'sale_return'),
    parseEntityFromSync(req.params.id, 'account_txn'),
  ]);

  const invoiceBal = customerInvoiceBalances(sales, custPayments, saleReturns, accountTxns);
  const custMap = new Map(customers.map((c: any) => [String(c.id), { name: c.name || '—', phone: c.phone || '', outstanding_balance: invoiceBal.get(String(c.id)) ?? 0 }]));

  // Build per-customer khata balance from sync events
  const khataPaidMap = new Map<string, number>();
  for (const p of khataPayments) {
    const kid = String(p.khata_id ?? '');
    if (!kid) continue;
    khataPaidMap.set(kid, (khataPaidMap.get(kid) ?? 0) + toNumber(p.amount));
  }
  const khataBalanceByCustomer = new Map<string, number>();
  for (const k of customerKhata) {
    if (String(k.status ?? 'open').toLowerCase() === 'closed') continue;
    const cid = String(k.customer_id ?? '');
    const paid = khataPaidMap.get(String(k.id)) ?? 0;
    const bal = Math.max(0, toNumber(k.total_amount) - paid);
    khataBalanceByCustomer.set(cid, (khataBalanceByCustomer.get(cid) ?? 0) + bal);
  }

  const membersByLoc = new Map<string, any[]>();
  for (const m of members) {
    const lid = String(m.location_id);
    if (!membersByLoc.has(lid)) membersByLoc.set(lid, []);
    const cust = custMap.get(String(m.customer_id));
    const khataBalance = khataBalanceByCustomer.get(String(m.customer_id)) ?? 0;
    membersByLoc.get(lid)!.push({ ...m, customer_name: cust?.name ?? '—', phone: cust?.phone ?? '', outstanding_balance: (cust?.outstanding_balance ?? 0) + khataBalance });
  }

  const enriched = locations.map((loc: any) => {
    const mems = membersByLoc.get(String(loc.id)) ?? [];
    return { ...loc, members: mems, member_count: mems.length, total_owed: mems.reduce((s: number, m: any) => s + m.outstanding_balance, 0) };
  });

  res.json({ success: true, data: enriched });
});

// ── Agreement ─────────────────────────────────────────────────────────────────
router.get('/instances/:id/agreement', async (req: Request, res: Response) => {
  const exists = await prisma.instance.findUnique({ where: { instance_id: req.params.id }, select: { id: true } });
  if (!exists) { res.status(404).json({ success: false, error: 'Instance not found' }); return; }

  const agreements = await parseEntityFromSync(req.params.id, 'agreement');
  const latest = agreements
    .sort((a: any, b: any) => new Date(b.signed_at || b.created_at || 0).getTime() - new Date(a.signed_at || a.created_at || 0).getTime())[0] ?? null;

  res.json({ success: true, data: latest });
});

// ── POS Users ─────────────────────────────────────────────────────────────────
const _USER_ENC_KEY = crypto.createHash('sha256').update('OsaTechPOS_UserKey_2024!@#Munib').digest();
function decryptUserPassword(enc: string): string {
  try {
    const [ivH, dataH] = enc.split(':');
    const d = crypto.createDecipheriv('aes-256-cbc', _USER_ENC_KEY, Buffer.from(ivH, 'hex'));
    return Buffer.concat([d.update(Buffer.from(dataH, 'hex')), d.final()]).toString('utf8');
  } catch { return '(unreadable)'; }
}

router.get('/instances/:id/users', async (req: Request, res: Response) => {
  const exists = await prisma.instance.findUnique({ where: { instance_id: req.params.id }, select: { id: true } });
  if (!exists) { res.status(404).json({ success: false, error: 'Instance not found' }); return; }

  const raw = await parseEntityFromSync(req.params.id, 'pos_user');
  // Keep only the latest record per user id (upsert semantics)
  const byId = new Map<number, any>();
  for (const u of raw.sort((a: any, b: any) => new Date(a.created_at || 0).getTime() - new Date(b.created_at || 0).getTime())) {
    byId.set(u.id, u);
  }
  const users = [...byId.values()].map((u: any) => ({
    id:         u.id,
    full_name:  u.full_name,
    username:   u.username,
    role:       u.role,
    is_active:  u.is_active,
    created_at: u.created_at,
    password:   u.password_enc ? decryptUserPassword(u.password_enc) : '—',
  }));

  res.json({ success: true, data: users });
});

// ── Analytics ─────────────────────────────────────────────────────────────────
router.get('/analytics', async (req: Request, res: Response) => {
  const { date_from, date_to } = req.query as Record<string, string>;
  const hasDateRange = !!(date_from && date_to);

  // POS day of a sale: ISO-UTC strings converted to Pakistan time; local 'YYYY-MM-DD HH:MM:SS' kept.
  // (CAST(date_created AS TIMESTAMP) dropped the zone and mis-dated evening web sales.)
  const PK_DAY = Prisma.sql`(CASE WHEN date_created ~ '[Tt].*(Z|[+-][0-9]{2}:?[0-9]{2})$'
    THEN TO_CHAR((date_created::timestamptz AT TIME ZONE 'Asia/Karachi'), 'YYYY-MM-DD')
    ELSE LEFT(date_created, 10) END)`;
  const ACTIVE_SALE = Prisma.sql`LOWER(COALESCE(status, 'completed')) IN ('completed', 'paid', 'partial')`;
  const daysAgo = (n: number) => new Date(Date.now() + 5 * 3600_000 - n * 86_400_000).toISOString().slice(0, 10);
  const rangeSql = hasDateRange
    ? Prisma.sql`AND ${PK_DAY} BETWEEN ${date_from} AND ${date_to}`
    : Prisma.empty;

  const salesDayQ = (whereClause: Prisma.Sql) => prisma.$queryRaw<any[]>(Prisma.sql`
    SELECT ${PK_DAY} AS day,
           COUNT(*)::int                                           AS sales_count,
           COALESCE(SUM(total), 0)::float                         AS revenue,
           COUNT(DISTINCT instance_id)::int                       AS active_stores
    FROM instance_sales
    WHERE date_created IS NOT NULL AND ${ACTIVE_SALE} ${whereClause}
    GROUP BY 1 ORDER BY 1
  `);

  // Latest event per entity id (edits/re-syncs must not double count; deleted rows drop out).
  const latestEntities = (entityType: string) => Prisma.sql`
    SELECT DISTINCT ON (instance_id, (payload::jsonb)->>'id')
           instance_id, operation, payload::jsonb AS p, received_at
    FROM sync_events
    WHERE entity_type = ${entityType}
    ORDER BY instance_id, (payload::jsonb)->>'id', id DESC`;
  const num = (field: string) => Prisma.raw(
    `(CASE WHEN p->>'${field}' ~ '^-?[0-9]+([.][0-9]+)?$' THEN (p->>'${field}')::float ELSE 0 END)`);
  const expenseMonthsQ = (rangeClause: Prisma.Sql) => prisma.$queryRaw<any[]>(Prisma.sql`
    WITH latest AS (${latestEntities('expense')}),
    e AS (
      SELECT COALESCE(NULLIF(LEFT(p->>'date_added', 10), ''), NULLIF(LEFT(p->>'date_created', 10), ''),
                      NULLIF(LEFT(p->>'date', 10), ''), TO_CHAR(received_at, 'YYYY-MM-DD')) AS day,
             ${num('amount')} AS amt
      FROM latest WHERE operation != 'delete'
    )
    SELECT LEFT(day, 7) AS month, COALESCE(SUM(amt), 0)::float AS expenses
    FROM e WHERE TRUE ${rangeClause}
    GROUP BY 1 ORDER BY 1
  `);

  // Run all independent queries in parallel — eliminates 12 sequential round-trips
  const [
    revenueByInstance,
    activityDistribution,
    planDistribution,
    statusDistribution,
    salesByDayPrimary,
    salesByDayFallback,
    topEntityTypes,
    recentSummaries,
    totalsAgg,
    plRevPrimary,
    plExpPrimary,
    plRevFallback,
    plExpFallback,
    regTrend,
    accountTypeDist,
    accountTxnVolume,
    accountBalRow,
    accountTxnRow,
  ] = await Promise.all([
    // 1. Revenue by instance (top 10)
    hasDateRange
      ? prisma.$queryRaw<any[]>(Prisma.sql`
          SELECT i.instance_id, i.store_name, i.owner_mobile,
                 COALESCE(s.total_revenue, 0) AS total_revenue,
                 COALESCE(s.total_sales, 0)   AS total_sales,
                 i.total_customers, i.total_products
          FROM instances i
          LEFT JOIN (
            SELECT instance_id, SUM(total)::float AS total_revenue, COUNT(*)::int AS total_sales
            FROM instance_sales
            WHERE date_created IS NOT NULL AND ${ACTIVE_SALE} ${rangeSql}
            GROUP BY instance_id
          ) s ON s.instance_id = i.instance_id
          WHERE i.approval_status = 'approved'
          ORDER BY COALESCE(s.total_revenue, 0) DESC LIMIT 10
        `)
      : prisma.instance.findMany({
          where:   { approval_status: 'approved' },
          orderBy: { total_revenue: 'desc' },
          take:    10,
          select:  { instance_id: true, store_name: true, owner_mobile: true, total_revenue: true, total_sales: true, total_customers: true, total_products: true },
        }),

    // 2. Activity distribution
    prisma.$queryRaw<any[]>(Prisma.sql`
      SELECT
        CASE
          WHEN last_seen >= NOW() - INTERVAL '1 day'   THEN 'Today'
          WHEN last_seen >= NOW() - INTERVAL '7 days'  THEN 'This Week'
          WHEN last_seen >= NOW() - INTERVAL '30 days' THEN 'This Month'
          WHEN last_seen IS NOT NULL                   THEN 'Older'
          ELSE 'Never'
        END AS period,
        COUNT(*)::int AS count
      FROM instances
      GROUP BY 1
      ORDER BY CASE
        WHEN last_seen >= NOW() - INTERVAL '1 day'   THEN 1
        WHEN last_seen >= NOW() - INTERVAL '7 days'  THEN 2
        WHEN last_seen >= NOW() - INTERVAL '30 days' THEN 3
        WHEN last_seen IS NOT NULL                   THEN 4
        ELSE 5
      END
    `),

    // 3. Plan distribution
    prisma.$queryRaw<any[]>(Prisma.sql`
      SELECT COALESCE(NULLIF(license_plan,''),'none') AS plan, COUNT(*)::int AS count
      FROM instances WHERE approval_status = 'approved'
      GROUP BY plan ORDER BY count DESC
    `),

    // 4. Status distribution
    prisma.$queryRaw<any[]>(Prisma.sql`
      SELECT approval_status AS status, COUNT(*)::int AS count
      FROM instances GROUP BY approval_status
    `),

    // 5a. Sales by day — primary window
    hasDateRange
      ? salesDayQ(rangeSql)
      : salesDayQ(Prisma.sql`AND ${PK_DAY} >= ${daysAgo(30)}`),

    // 5b. Sales by day — all-time fallback (runs in parallel, used only if primary is empty)
    salesDayQ(Prisma.sql``),

    // 6. Top entity types
    prisma.$queryRaw<any[]>(Prisma.sql`
      SELECT entity_type, COUNT(*)::int AS event_count
      FROM sync_events GROUP BY entity_type ORDER BY event_count DESC
    `),

    // 7. Top products — LIMIT 500 recent rows instead of all rows
    prisma.instanceSale.findMany({
      where:   { items_summary: { not: '' } },
      select:  { items_summary: true },
      orderBy: { id: 'desc' },
      take:    500,
    }),

    // 8. Global totals
    prisma.instance.aggregate({
      where: { approval_status: 'approved' },
      _sum:  { total_customers: true, total_products: true, total_sales: true, total_revenue: true },
    }),

    // 9a. P&L revenue — primary window
    prisma.$queryRaw<any[]>(Prisma.sql`
      SELECT LEFT(${PK_DAY}, 7) AS month, COALESCE(SUM(total), 0)::float AS revenue
      FROM instance_sales
      WHERE date_created IS NOT NULL AND ${ACTIVE_SALE}
        ${hasDateRange ? rangeSql : Prisma.sql`AND ${PK_DAY} >= ${daysAgo(365)}`}
      GROUP BY 1 ORDER BY 1
    `),

    // 9b. P&L expenses — primary window (by the expense's own date, latest version only)
    expenseMonthsQ(hasDateRange
      ? Prisma.sql`AND day BETWEEN ${date_from} AND ${date_to}`
      : Prisma.sql`AND day >= ${daysAgo(365)}`),

    // 9c. P&L revenue fallback — all-time (runs in parallel, used only if primary is empty)
    prisma.$queryRaw<any[]>(Prisma.sql`
      SELECT LEFT(${PK_DAY}, 7) AS month, COALESCE(SUM(total), 0)::float AS revenue
      FROM instance_sales WHERE date_created IS NOT NULL AND ${ACTIVE_SALE}
      GROUP BY 1 ORDER BY 1
    `),

    // 9d. P&L expenses fallback — all-time
    expenseMonthsQ(Prisma.empty),

    // 10. Registration trend
    prisma.$queryRaw<any[]>(Prisma.sql`
      SELECT TO_CHAR(created_at, 'YYYY-MM') AS month, COUNT(*)::int AS count
      FROM instances GROUP BY month ORDER BY month
    `),

    // 11–14. Account stats (4 queries already in parallel via outer Promise.all)
    // Account balance = opening_balance + Σin − Σout over the latest version of each txn
    // (accounts carry no 'balance' field, so the old SUM read 0).
    prisma.$queryRaw<any[]>(Prisma.sql`
      WITH acc AS (${latestEntities('account')}),
      tx AS (${latestEntities('account_txn')}),
      d AS (
        SELECT instance_id, p->>'account_id' AS aid,
               SUM(CASE WHEN LOWER(p->>'type') = 'in' THEN ${num('amount')}
                        WHEN LOWER(p->>'type') = 'out' THEN -${num('amount')} ELSE 0 END) AS delta
        FROM tx WHERE operation != 'delete' GROUP BY 1, 2
      )
      SELECT COALESCE(NULLIF(a.p->>'type', ''), 'other') AS account_type,
             COUNT(*)::int AS count,
             COALESCE(SUM(${Prisma.raw(`(CASE WHEN a.p->>'opening_balance' ~ '^-?[0-9]+([.][0-9]+)?$' THEN (a.p->>'opening_balance')::float ELSE 0 END)`)} + COALESCE(d.delta, 0)), 0)::float AS total_balance
      FROM acc a LEFT JOIN d ON d.instance_id = a.instance_id AND d.aid = a.p->>'id'
      WHERE a.operation != 'delete'
      GROUP BY 1 ORDER BY 3 DESC
    `),
    prisma.$queryRaw<any[]>(Prisma.sql`
      WITH tx AS (${latestEntities('account_txn')})
      SELECT COALESCE(NULLIF(LOWER(p->>'type'), ''), 'other') AS txn_type,
             COUNT(*)::int AS count,
             COALESCE(SUM(${num('amount')}), 0)::float AS total_amount
      FROM tx WHERE operation != 'delete'
      GROUP BY 1 ORDER BY 3 DESC
    `),
    Promise.resolve([{ total: 0 }] as [{ total: number }]),
    prisma.$queryRaw<[{ cnt: bigint }]>(Prisma.sql`
      WITH tx AS (${latestEntities('account_txn')})
      SELECT COUNT(*)::int AS cnt FROM tx WHERE operation != 'delete'
    `),
  ]);

  // Pick best salesByDay result
  const salesByDay: any[] = salesByDayPrimary.length > 0 ? salesByDayPrimary : salesByDayFallback;

  // Pick best P&L result
  const plRevRows: any[] = plRevPrimary.length > 0 ? plRevPrimary : plRevFallback;
  const plExpRows: any[] = plExpPrimary.length > 0 ? plExpPrimary : plExpFallback;

  // Build P&L merge
  const plMerge = new Map<string, { revenue: number; expenses: number }>();
  for (const r of plRevRows) plMerge.set(r.month, { revenue: Number(r.revenue), expenses: 0 });
  for (const e of plExpRows) {
    const ex = plMerge.get(e.month) ?? { revenue: 0, expenses: 0 };
    plMerge.set(e.month, { ...ex, expenses: Number(e.expenses) });
  }
  const profitLossData = Array.from(plMerge.entries()).sort(([a], [b]) => a.localeCompare(b))
    .map(([month, d]) => ({ month, revenue: Math.round(d.revenue), expenses: Math.round(d.expenses), profit: Math.round(d.revenue - d.expenses) }));

  // Build registrationsTrend with cumulative total
  let cumulative = 0;
  const registrationsTrend = regTrend.map((r: any) => {
    cumulative += Number(r.count);
    return { month: r.month, newStores: Number(r.count), total: cumulative };
  });

  // Parse top products from limited recent summaries
  const productQtyMap = new Map<string, number>();
  for (const row of recentSummaries) {
    if (!row.items_summary) continue;
    for (const part of row.items_summary.split(',')) {
      const match = part.trim().match(/^(.+?)\s*\(x(\d+)\)$/);
      if (match) {
        const name = match[1].trim();
        productQtyMap.set(name, (productQtyMap.get(name) ?? 0) + (parseInt(match[2], 10) || 1));
      }
    }
  }
  const topProducts = Array.from(productQtyMap.entries())
    .sort((a, b) => b[1] - a[1]).slice(0, 12).map(([name, qty]) => ({ name, qty }));

  res.json({
    success: true,
    data: {
      revenueByInstance, activityDistribution, planDistribution, statusDistribution,
      salesByDay, topEntityTypes, topProducts,
      totals: {
        total_customers: Number(totalsAgg._sum.total_customers || 0),
        total_products:  Number(totalsAgg._sum.total_products  || 0),
        total_sales:     Number(totalsAgg._sum.total_sales     || 0),
        total_revenue:   Number(totalsAgg._sum.total_revenue   || 0),
      },
      profitLossData,
      registrationsTrend,
      accountStats: {
        typeDist:     accountTypeDist,
        txnVolume:    accountTxnVolume,
        totalBalance: Math.round(accountTypeDist.reduce((s: number, r: any) => s + Number(r.total_balance || 0), 0)),
        totalTxns:    Number(accountTxnRow[0]?.cnt || 0),
      },
    },
  });
});

// ── Licenses ──────────────────────────────────────────────────────────────────
router.get('/licenses', async (_req: Request, res: Response) => {
  const keys = await prisma.licenseKey.findMany({
    orderBy: { issued_at: 'desc' },
    include: { instance: { select: { store_name: true, owner_mobile: true } } },
  });
  const data = keys.map(k => ({
    ...k,
    store_name:   k.instance?.store_name   ?? null,
    owner_mobile: k.instance?.owner_mobile ?? null,
    instance:     undefined,
  }));
  res.json({ success: true, data });
});

router.post('/licenses', async (req: Request, res: Response) => {
  try {
    const { plan, duration_days, notes, instance_id } = req.body as { plan: string; duration_days?: number; notes?: string; instance_id?: string };
    if (!plan) { res.status(400).json({ success: false, error: 'plan is required' }); return; }

    const days      = Number(duration_days) || 30;
    const generated = generateLicenseKey({ issuedTo: 'Unknown Business', fingerprint: '', plan, durationDays: days });

    const key = await prisma.licenseKey.create({
      data: { license_key: generated.licenseKey, instance_id: instance_id || null, plan, duration_days: days, expires_at: generated.expiresAt, notes: notes || '' },
    });

    if (instance_id) {
      await prisma.instance.update({
        where: { instance_id },
        data:  { license_key: generated.licenseKey, license_plan: plan, license_expiry: generated.expiresAt },
      });
    }

    res.status(201).json({ success: true, data: { id: key.id, license_key: generated.licenseKey, plan, duration_days: days, expires_at: generated.expiresAt } });
  } catch (e: any) {
    console.error('[create-license]', e.message);
    res.status(500).json({ success: false, error: e.message || 'License creation failed' });
  }
});

router.post('/licenses/:key/assign', async (req: Request, res: Response) => {
  const { instance_id } = req.body as { instance_id?: string };
  if (!instance_id) { res.status(400).json({ success: false, error: 'instance_id is required' }); return; }

  const lic = await prisma.licenseKey.findFirst({ where: { license_key: req.params.key, is_active: true } });
  if (!lic) { res.status(404).json({ success: false, error: 'License key not found or inactive' }); return; }

  await prisma.licenseKey.update({ where: { license_key: req.params.key }, data: { instance_id } });
  await prisma.instance.update({
    where: { instance_id },
    data:  { approval_status: 'approved', license_revoked: 0, block_reason: '', license_key: req.params.key, license_plan: lic.plan, license_expiry: lic.expires_at },
  });

  res.json({ success: true, message: `License ${req.params.key} assigned and instance approved` });
});

router.delete('/licenses/:key', async (req: Request, res: Response) => {
  const lic = await prisma.licenseKey.findUnique({ where: { license_key: req.params.key } });
  if (!lic) { res.status(404).json({ success: false, error: 'License key not found' }); return; }
  await prisma.licenseKey.update({ where: { license_key: req.params.key }, data: { is_active: false } });
  res.json({ success: true, message: 'License deactivated' });
});

// ── Notifications ─────────────────────────────────────────────────────────────
router.get('/notifications', async (_req: Request, res: Response) => {
  const notifications = await prisma.$queryRaw<any[]>(Prisma.sql`
    SELECT n.*,
      (SELECT COUNT(*)::int FROM notification_reads r WHERE r.notification_id = n.id) AS read_count,
      CASE WHEN n.target_instance_id IS NULL
           THEN (SELECT COUNT(*)::int FROM instances WHERE approval_status = 'approved')
           ELSE 1 END AS target_count,
      i.store_name AS target_store_name
    FROM notifications n
    LEFT JOIN instances i ON n.target_instance_id = i.instance_id
    WHERE n.is_active = true
    ORDER BY n.sent_at DESC LIMIT 200
  `);
  res.json({ success: true, data: notifications });
});

router.post('/notifications', async (req: Request, res: Response) => {
  const {
    title, body, instance_id,
    duration_hours,  // null = permanent
    display_type = 'marquee',  // 'marquee' | 'banner' | 'popup'
    style = 'violet',          // visual style preset key
  } = req.body as {
    title: string; body: string; instance_id?: string;
    duration_hours?: number | null; display_type?: string; style?: string;
  };

  if (!title?.trim() || !body?.trim()) {
    res.status(400).json({ success: false, error: 'title and body are required' });
    return;
  }
  if (instance_id) {
    const exists = await prisma.instance.findUnique({ where: { instance_id }, select: { id: true } });
    if (!exists) { res.status(404).json({ success: false, error: 'Target instance not found' }); return; }
  }

  const expires_at = duration_hours
    ? new Date(Date.now() + Number(duration_hours) * 3_600_000)
    : null;

  const note = await prisma.notification.create({
    data: {
      title: title.trim(),
      body:  body.trim(),
      target_instance_id: instance_id || null,
      display_type: display_type || 'marquee',
      style: style || 'violet',
      expires_at,
    },
  });

  res.status(201).json({
    success: true,
    data: {
      id:                 note.id,
      title:              note.title,
      body:               note.body,
      target_instance_id: note.target_instance_id,
      display_type:       note.display_type,
      style:              note.style,
      expires_at:         note.expires_at,
    },
  });
});

router.delete('/notifications/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const note = await prisma.notification.findUnique({ where: { id } });
  if (!note) { res.status(404).json({ success: false, error: 'Notification not found' }); return; }

  // Delete reads first (FK constraint), then the notification itself
  await prisma.notificationRead.deleteMany({ where: { notification_id: id } });
  await prisma.notification.delete({ where: { id } });

  res.json({ success: true, message: 'Notification deleted' });
});

// ── Demo seed ─────────────────────────────────────────────────────────────────
router.post('/seed-demo', async (_req: Request, res: Response) => {
  try {
    const existingCount = await prisma.instance.count();

    const PRODUCTS_DEMO = [
      { name: 'Pepsi 1.5L',        category: 'Beverages',     price: 150,  purchase: 120  },
      { name: 'Coca-Cola 500ml',   category: 'Beverages',     price: 70,   purchase: 55   },
      { name: 'Lipton Tea 500g',   category: 'Groceries',     price: 680,  purchase: 560  },
      { name: 'Dettol Soap',       category: 'Personal Care', price: 120,  purchase: 95   },
      { name: 'Shan Masala',       category: 'Groceries',     price: 95,   purchase: 75   },
      { name: 'Nestle Milk 1L',    category: 'Dairy',         price: 260,  purchase: 220  },
      { name: 'Sunsilk Shampoo',   category: 'Personal Care', price: 300,  purchase: 245  },
      { name: 'Lays Chips',        category: 'Snacks',        price: 50,   purchase: 38   },
      { name: 'Ariel Detergent',   category: 'Household',     price: 450,  purchase: 370  },
      { name: 'Colgate Paste',     category: 'Personal Care', price: 175,  purchase: 140  },
      { name: 'Whole Wheat Bread', category: 'Bakery',        price: 140,  purchase: 110  },
      { name: 'Basmati Rice 5kg',  category: 'Groceries',     price: 1800, purchase: 1550 },
    ];

    const STORES_DEMO = [
      { name: 'Khan General Store', owner: 'Bilal Khan',   mobile: '03001234567', plan: 'yearly',    days: 365, status: 'approved' as const },
      { name: 'City Mart',          owner: 'Usman Raza',   mobile: '03111234567', plan: 'monthly',   days: 30,  status: 'approved' as const },
      { name: 'Al-Baraka Traders',  owner: 'Asim Nawaz',   mobile: '03211234567', plan: 'quarterly', days: 90,  status: 'approved' as const },
      { name: 'Metro Mini Market',  owner: 'Farhan Ahmed', mobile: '03311234567', plan: 'monthly',   days: 30,  status: 'approved' as const },
      { name: 'Sunrise Store',      owner: 'Naveed Iqbal', mobile: '03001119876', plan: 'none',      days: 0,   status: 'pending'  as const },
      { name: 'Green Valley Shop',  owner: 'Kamran Malik', mobile: '03121119876', plan: 'none',      days: 0,   status: 'pending'  as const },
    ];

    const rnd     = (a: number, b: number) => Math.floor(Math.random() * (b - a + 1)) + a;
    const randDate = (daysBack: number) => new Date(Date.now() - rnd(0, daysBack * 86400000)).toISOString().replace('T', ' ').slice(0, 19);
    const hoursAgo = (h: number) => new Date(Date.now() - h * 3600000);
    const PAYMENT_METHODS = ['cash', 'card', 'online'];

    let instancesCreated = 0, salesCreated = 0, productsCreated = 0;

    for (let si = 0; si < STORES_DEMO.length; si++) {
      const s          = STORES_DEMO[si];
      const instanceId = `demo_${s.mobile}`;
      const apiKey     = `ak_demo_${crypto.randomBytes(16).toString('hex')}`;
      const licKey     = s.plan !== 'none'
        ? generateLicenseKey({ issuedTo: s.name, fingerprint: '', plan: s.plan, durationDays: s.days }).licenseKey : '';
      const expiry     = s.plan !== 'none' && s.days > 0 ? new Date(Date.now() + s.days * 86400000).toISOString() : null;
      const totalSales = s.status === 'approved' ? rnd(40, 180) : 0;
      const daysAgo    = si * 7;

      const inst = await prisma.instance.upsert({
        where:  { instance_id: instanceId },
        create: {
          instance_id:     instanceId, store_name: s.name, owner_name: s.owner,
          owner_mobile:    s.mobile, business_name: s.name, api_key: apiKey,
          license_key:     licKey, license_plan: s.plan, license_expiry: expiry,
          approval_status: s.status, last_seen: hoursAgo(rnd(1, si * 12 + 2)),
          total_sales:     totalSales,
          total_revenue:   totalSales * rnd(300, 1400),
          total_customers: s.status === 'approved' ? rnd(8, 50) : 0,
          total_products:  s.status === 'approved' ? PRODUCTS_DEMO.length : 0,
          created_at:      new Date(Date.now() - daysAgo * 86400000),
        },
        update: {},
      });

      if (inst) instancesCreated++;
      if (s.status !== 'approved') continue;

      // Sales
      let posId = rnd(100, 999);
      const salesData: any[] = [];
      for (let i = 0; i < totalSales; i++) {
        posId++;
        const numItems = rnd(1, 4);
        let total = 0;
        const parts: string[] = [];
        for (let j = 0; j < numItems; j++) {
          const p   = PRODUCTS_DEMO[rnd(0, PRODUCTS_DEMO.length - 1)];
          const qty = rnd(1, 3);
          total += p.price * qty;
          parts.push(`${p.name} (x${qty})`);
        }
        const disc = Math.random() > 0.85 ? Math.floor(total * rnd(5, 12) / 100) : 0;
        salesData.push({ instance_id: instanceId, pos_sale_id: posId, total: total - disc, discount: disc, payment_method: PAYMENT_METHODS[rnd(0, 2)], payment_status: 'Paid', status: 'Completed', items_count: numItems, items_summary: parts.join(', '), date_created: randDate(90) });
      }

      const salesResult = await prisma.instanceSale.createMany({ data: salesData, skipDuplicates: true });
      salesCreated += salesResult.count;

      // Products via sync_events
      const eventsData = PRODUCTS_DEMO.map((p, i) => ({
        instance_id: instanceId, entity_type: 'product', operation: 'create',
        payload: JSON.stringify({ id: i + 1, name: p.name, category: p.category, price: p.price, purchase_price: p.purchase, stock: rnd(10, 400) }),
        received_at: new Date(Date.now() - rnd(0, 60 * 86400000)),
      }));
      const evResult = await prisma.syncEvent.createMany({ data: eventsData });
      productsCreated += evResult.count;
    }

    res.json({
      success: true,
      message: existingCount > 0 ? `Demo data merged (${existingCount} instances already existed)` : 'Demo data seeded successfully',
      data: { instances: instancesCreated, sales: salesCreated, products: productsCreated },
    });
  } catch (err: any) {
    console.error('[seed-demo]', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── App Releases (Software Update) ─────────────────────────────────────────

/**
 * GET /api/admin/releases
 * All releases, newest first.
 */
router.get('/releases', async (_req: Request, res: Response) => {
  const releases = await prisma.appRelease.findMany({ orderBy: { created_at: 'desc' } });
  res.json({ success: true, data: releases });
});

/**
 * POST /api/admin/releases/upload   (multipart/form-data, field "file")
 * Uploads the installer to the VPS and returns a backend-hosted download URL.
 * The admin then submits POST /releases with this download_url + file_size.
 */
router.post('/releases/upload', releaseUpload.single('file'), (req: Request, res: Response) => {
  const file = (req as any).file as Express.Multer.File | undefined;
  if (!file) {
    res.status(400).json({ success: false, error: 'No installer uploaded. Allowed: .exe, .msi, .zip, .dmg, .AppImage' });
    return;
  }
  // Build an absolute URL the POS can fetch directly. Prefer an explicit
  // PUBLIC_BACKEND_URL (set behind nginx/HTTPS); else derive from the request.
  const base = (process.env.PUBLIC_BACKEND_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  const download_url = `${base}/api/updates/download/${encodeURIComponent(file.filename)}`;
  res.json({
    success: true,
    data: {
      download_url,
      file_size: file.size,
      filename: file.filename,
      original_name: file.originalname,
    },
  });
});

/**
 * POST /api/admin/releases
 * Create a new release entry.
 * Body: { version, channel?, changelog?, download_url, file_size?, is_mandatory?, published? }
 */
router.post('/releases', async (req: Request, res: Response) => {
  const {
    version, channel = 'stable', changelog = '', download_url,
    file_size = 0, is_mandatory = false, published = true,
  } = req.body as Record<string, any>;

  if (!version?.trim())     { res.status(400).json({ success: false, error: 'version is required' }); return; }
  if (!download_url?.trim()){ res.status(400).json({ success: false, error: 'download_url is required' }); return; }

  // Check duplicate version
  const existing = await prisma.appRelease.findUnique({ where: { version: version.trim() } });
  if (existing) { res.status(409).json({ success: false, error: `Version ${version} already exists` }); return; }

  const release = await prisma.appRelease.create({
    data: {
      version:      version.trim(),
      channel:      channel || 'stable',
      changelog:    changelog || '',
      download_url: download_url.trim(),
      file_size:    Number(file_size) || 0,
      is_mandatory: !!is_mandatory,
      published:    published !== false,
    },
  });

  res.status(201).json({ success: true, data: release });
});

/**
 * PATCH /api/admin/releases/:id
 * Update fields (publish/unpublish, toggle mandatory, fix changelog, etc.)
 */
router.patch('/releases/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const allowed = ['changelog', 'download_url', 'file_size', 'is_mandatory', 'published', 'channel'];
  const data: Record<string, any> = {};
  for (const k of allowed) {
    if (req.body[k] !== undefined) data[k] = req.body[k];
  }
  const release = await prisma.appRelease.update({ where: { id }, data });
  res.json({ success: true, data: release });
});

/**
 * DELETE /api/admin/releases/:id
 * Remove a release record entirely.
 */
router.delete('/releases/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  await prisma.appRelease.delete({ where: { id } });
  res.json({ success: true, message: 'Release deleted' });
});

// ─── Instance Branches (child instances) ─────────────────────────────────────

/**
 * GET /api/admin/instances/:id/branches
 * Returns all instances that registered as a branch under this parent instance.
 */
router.get('/instances/:id/branches', async (req: Request, res: Response) => {
  const parentId = req.params.id;

  const branches = await prisma.instance.findMany({
    where:   { parent_instance_id: parentId } as any,
    orderBy: { created_at: 'desc' },
    select: {
      instance_id:        true,
      store_name:         true,
      branch_name:        true,
      branch_code:        true,
      owner_name:         true,
      owner_mobile:       true,
      approval_status:    true,
      last_seen:          true,
      app_version:        true,
      total_sales:        true,
      total_revenue:      true,
      license_plan:       true,
      license_expiry:     true,
      created_at:         true,
    } as any,
  });

  res.json({ success: true, data: branches, total: branches.length });
});

// ─── Branch Requests ─────────────────────────────────────────────────────────

/**
 * GET /api/admin/branch-requests
 * List all branch requests, newest first.
 * Query: ?status=pending|approved|rejected
 */
router.get('/branch-requests', async (req: Request, res: Response) => {
  const { status, instance_id } = req.query as Record<string, string>;
  const where: any = {};
  if (status)      where.status      = status;
  if (instance_id) where.instance_id = instance_id;

  const requests = await prisma.branchRequest.findMany({
    where,
    orderBy: { created_at: 'desc' },
  });

  // Enrich with store_name
  const instanceIds = [...new Set(requests.map(r => r.instance_id))];
  const instances = await prisma.instance.findMany({
    where:  { instance_id: { in: instanceIds } },
    select: { instance_id: true, store_name: true, owner_mobile: true },
  });
  const instMap = new Map(instances.map(i => [i.instance_id, i]));

  const enriched = requests.map(r => ({
    ...r,
    store_name:   instMap.get(r.instance_id)?.store_name   ?? r.instance_id,
    owner_mobile: instMap.get(r.instance_id)?.owner_mobile ?? '',
  }));

  res.json({ success: true, data: enriched, total: enriched.length });
});

/**
 * PATCH /api/admin/branch-requests/:id/approve
 * Approve a branch request — generate a unique branch_code and branch_id.
 * Body: { admin_note? }
 */
router.patch('/branch-requests/:id/approve', async (req: Request, res: Response) => {
  try {
    const id   = Number(req.params.id);
    const { admin_note = '' } = req.body as { admin_note?: string };

    const request = await prisma.branchRequest.findUnique({ where: { id } });
    if (!request) {
      res.status(404).json({ success: false, error: 'Branch request not found' });
      return;
    }
    if (request.status !== 'pending') {
      res.status(409).json({ success: false, error: `Request is already ${request.status}` });
      return;
    }

    // Generate a short unique branch code: BR-XXXXXX
    const branchCode = `BR-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    const branchId   = uuidv4();

    const updated = await prisma.branchRequest.update({
      where: { id },
      data:  {
        status:      'approved',
        branch_code: branchCode,
        branch_id:   branchId,
        admin_note:  admin_note.trim(),
      },
    });

    res.json({
      success:     true,
      message:     `Branch request approved — code: ${branchCode}`,
      data:        updated,
      branch_code: branchCode,
      branch_id:   branchId,
    });
  } catch (e: any) {
    console.error('[branch-requests/approve]', e.message);
    res.status(500).json({ success: false, error: e.message || 'Approval failed' });
  }
});

/**
 * PATCH /api/admin/branch-requests/:id/reject
 * Reject a branch request.
 * Body: { admin_note? }
 */
router.patch('/branch-requests/:id/reject', async (req: Request, res: Response) => {
  try {
    const id   = Number(req.params.id);
    const { admin_note = '' } = req.body as { admin_note?: string };

    const request = await prisma.branchRequest.findUnique({ where: { id } });
    if (!request) {
      res.status(404).json({ success: false, error: 'Branch request not found' });
      return;
    }
    if (request.status !== 'pending') {
      res.status(409).json({ success: false, error: `Request is already ${request.status}` });
      return;
    }

    const updated = await prisma.branchRequest.update({
      where: { id },
      data:  { status: 'rejected', admin_note: admin_note.trim() },
    });

    res.json({ success: true, message: 'Branch request rejected', data: updated });
  } catch (e: any) {
    console.error('[branch-requests/reject]', e.message);
    res.status(500).json({ success: false, error: e.message || 'Rejection failed' });
  }
});


// ─── Data Management ──────────────────────────────────────────────────────────

// Categorised sets for the purge UI
const PURGEABLE_GROUPS: Record<string, { label: string; types: string[] }> = {
  sales:    { label: 'Sales & Returns',    types: ['sale', 'sale_item', 'sale_return', 'sale_return_item'] },
  expenses: { label: 'Expenses',           types: ['expense'] },
  purchases:{ label: 'Purchases',          types: ['purchase', 'inventory_batch', 'purchase_return', 'purchase_return_item'] },
  payments: { label: 'Payments & Ledger',  types: ['customer_payment', 'vendor_payment', 'account_txn', 'financial_transaction', 'register'] },
};
const ALL_PURGEABLE_TYPES = Object.values(PURGEABLE_GROUPS).flatMap(g => g.types);

/**
 * POST /api/admin/instances/:id/data/purge
 * Body: { groups: string[], beforeDate: string, preview?: boolean }
 *
 * preview=true  → dry-run: returns count + breakdown by entity_type, nothing deleted.
 * preview=false → deletes and returns the deleted events (up to UNDO_LIMIT) for
 *                 client-side undo. If count > UNDO_LIMIT, undo_available=false.
 */
const UNDO_LIMIT = 5_000; // max events returned for undo storage

router.post('/instances/:id/data/purge', async (req: Request, res: Response) => {
  try {
    const { groups, beforeDate, preview = false } = req.body as { groups?: string[]; beforeDate?: string; preview?: boolean };
    if (!Array.isArray(groups) || groups.length === 0) {
      res.status(400).json({ success: false, error: 'groups[] required' }); return;
    }
    if (!beforeDate) {
      res.status(400).json({ success: false, error: 'beforeDate required' }); return;
    }
    const cutoff = new Date(beforeDate);
    if (isNaN(cutoff.getTime())) {
      res.status(400).json({ success: false, error: 'Invalid date' }); return;
    }

    const instance = await prisma.instance.findUnique({ where: { instance_id: req.params.id }, select: { id: true } });
    if (!instance) { res.status(404).json({ success: false, error: 'Instance not found' }); return; }

    const entityTypes = groups.flatMap(g => PURGEABLE_GROUPS[g]?.types ?? []).filter(t => ALL_PURGEABLE_TYPES.includes(t));
    if (entityTypes.length === 0) {
      res.status(400).json({ success: false, error: 'No valid entity types in groups' }); return;
    }

    const where = { instance_id: req.params.id, entity_type: { in: entityTypes }, received_at: { lt: cutoff } };

    if (preview) {
      // Dry-run: group counts by entity_type
      const counts = await prisma.syncEvent.groupBy({
        by: ['entity_type'],
        where,
        _count: { _all: true },
        orderBy: { _count: { entity_type: 'desc' } },
      });
      const total = counts.reduce((s, r) => s + r._count._all, 0);
      res.json({ success: true, preview: true, total, breakdown: counts.map(r => ({ entity_type: r.entity_type, count: r._count._all })) });
      return;
    }

    // Fetch events for undo before deleting
    const undoEvents = await prisma.syncEvent.findMany({
      where,
      orderBy: { id: 'asc' },
      take: UNDO_LIMIT + 1,
      select: { entity_type: true, operation: true, payload: true, received_at: true },
    });
    const undoAvailable = undoEvents.length <= UNDO_LIMIT;
    const eventsForUndo = undoAvailable ? undoEvents : [];

    const result = await prisma.syncEvent.deleteMany({ where });

    res.json({
      success: true,
      deleted: result.count,
      entityTypes,
      undo_available: undoAvailable,
      // Return events for client-side undo storage (only when count is manageable)
      undo_events: eventsForUndo.map(e => ({
        entity_type: e.entity_type,
        operation: e.operation,
        payload: e.payload,
        received_at: e.received_at,
      })),
    });
  } catch (e: any) {
    console.error('[data/purge]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * DELETE /api/admin/instances/:id/data/wipe
 * Nuclear option — deletes ALL sync events and instance sales for this instance.
 * The Instance record (license, credentials, store info) is preserved.
 */
router.delete('/instances/:id/data/wipe', async (req: Request, res: Response) => {
  try {
    const instance = await prisma.instance.findUnique({ where: { instance_id: req.params.id }, select: { id: true } });
    if (!instance) { res.status(404).json({ success: false, error: 'Instance not found' }); return; }

    const [syncResult, saleResult] = await prisma.$transaction([
      prisma.syncEvent.deleteMany({ where: { instance_id: req.params.id } }),
      prisma.instanceSale.deleteMany({ where: { instance_id: req.params.id } }),
    ]);

    res.json({
      success: true,
      deleted: syncResult.count + saleResult.count,
      sync_events: syncResult.count,
      instance_sales: saleResult.count,
    });
  } catch (e: any) {
    console.error('[data/wipe]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * GET /api/admin/instances/:id/data/export-download
 * Same as /export but forces a JSON file download via Content-Disposition.
 * Optionally filter by group: ?groups=sales,expenses
 * Optionally filter by date range: ?from=ISO&to=ISO
 */
router.get('/instances/:id/data/export-download', async (req: Request, res: Response) => {
  try {
    const instance = await prisma.instance.findUnique({ where: { instance_id: req.params.id } });
    if (!instance) { res.status(404).json({ success: false, error: 'Instance not found' }); return; }

    const { groups: groupsParam, from, to } = req.query as Record<string, string>;

    let entityTypeFilter: string[] | undefined;
    if (groupsParam) {
      const groupKeys = groupsParam.split(',');
      entityTypeFilter = groupKeys.flatMap(g => PURGEABLE_GROUPS[g]?.types ?? []);
    }

    const dateFilter: { gte?: Date; lte?: Date } = {};
    if (from) { const d = new Date(from); if (!isNaN(d.getTime())) dateFilter.gte = d; }
    if (to)   { const d = new Date(to);   if (!isNaN(d.getTime())) dateFilter.lte = d; }

    const rawEvents = await prisma.syncEvent.findMany({
      where: {
        instance_id: req.params.id,
        ...(entityTypeFilter ? { entity_type: { in: entityTypeFilter } } : {}),
        ...(Object.keys(dateFilter).length ? { received_at: dateFilter } : {}),
      },
      orderBy: { id: 'asc' },
      select: { entity_type: true, operation: true, payload: true, received_at: true },
    });

    // Build structured (deduplicated) export
    const entityMap: Record<string, Map<string, any>> = {};
    for (const event of rawEvents) {
      const type = event.entity_type;
      if (!entityMap[type]) entityMap[type] = new Map();
      let payload: any;
      try { payload = JSON.parse(event.payload); } catch { continue; }
      if (!payload) continue;
      const key = String(payload?.id ?? payload?.barcode ?? Math.random());
      if (event.operation === 'delete') entityMap[type].delete(key);
      else entityMap[type].set(key, payload);
    }

    const exportData: Record<string, any[]> = {};
    for (const [singular, plural] of Object.entries(ENTITY_TO_TABLE)) {
      exportData[plural] = Array.from((entityMap[singular] ?? new Map()).values());
    }
    for (const [type, items] of Object.entries(entityMap)) {
      if (!ENTITY_TO_TABLE[type]) exportData[type] = Array.from(items.values());
    }

    const payload = {
      _osatech_export: true,
      exported_at: new Date().toISOString(),
      instance: { instance_id: instance.instance_id, store_name: instance.store_name, owner_name: instance.owner_name },
      data: exportData,
      raw_events: rawEvents.length,
    };

    const slug = (instance.store_name || instance.instance_id).replace(/[^a-z0-9]/gi, '_');
    const dateStr = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${slug}_export_${dateStr}.json"`);
    res.send(JSON.stringify(payload, null, 2));
  } catch (e: any) {
    console.error('[data/export-download]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * POST /api/admin/instances/:id/data/import
 * Body: { data: Record<string, any[]>, receivedAt?: string, mode?: 'preview'|'skip'|'overwrite' }
 *
 * mode='preview'   → dry-run; detects conflicts (entity ids that already exist) without inserting.
 * mode='skip'      → import only entities whose id does NOT already exist in sync_events.
 * mode='overwrite' → (default) import all; newer events will always win in replay.
 *
 * Returns { batchId } — a string the client stores so it can undo the import later.
 */
router.post(
  '/instances/:id/data/import',
  express.json({ limit: '50mb' }),
  async (req: Request, res: Response) => {
    try {
      const { data, receivedAt, mode = 'overwrite' } = req.body as {
        data?: Record<string, any[]>;
        receivedAt?: string;
        mode?: 'preview' | 'skip' | 'overwrite';
      };
      if (!data || typeof data !== 'object') {
        res.status(400).json({ success: false, error: '`data` object required' }); return;
      }

      const instance = await prisma.instance.findUnique({ where: { instance_id: req.params.id }, select: { id: true } });
      if (!instance) { res.status(404).json({ success: false, error: 'Instance not found' }); return; }

      // Build reverse mapping: plural table name → singular entity_type
      const TABLE_TO_ENTITY: Record<string, string> = {};
      for (const [entity, table] of Object.entries(ENTITY_TO_TABLE)) TABLE_TO_ENTITY[table] = entity;

      // Parse all incoming entities
      const incoming: { entityType: string; entity: any; key: string }[] = [];
      for (const [tableName, entities] of Object.entries(data)) {
        if (!Array.isArray(entities) || entities.length === 0) continue;
        const entityType = TABLE_TO_ENTITY[tableName] ?? tableName;
        for (const entity of entities) {
          if (!entity || typeof entity !== 'object') continue;
          const key = String(entity?.id ?? entity?.barcode ?? Math.random());
          incoming.push({ entityType, entity, key });
        }
      }

      // Find existing entity keys already in sync_events for this instance
      const entityTypes = [...new Set(incoming.map(e => e.entityType))];
      const existingEvents = await prisma.syncEvent.findMany({
        where: { instance_id: req.params.id, entity_type: { in: entityTypes } },
        select: { entity_type: true, payload: true, operation: true },
        orderBy: { id: 'asc' },
      });

      // Build set of existing keys per entity type (latest-wins replay)
      const existingKeys = new Map<string, Set<string>>(); // entityType → Set<key>
      for (const ev of existingEvents) {
        if (!existingKeys.has(ev.entity_type)) existingKeys.set(ev.entity_type, new Set());
        try {
          const p = JSON.parse(ev.payload);
          const key = String(p?.id ?? p?.barcode ?? '');
          if (key) {
            if (ev.operation === 'delete') existingKeys.get(ev.entity_type)!.delete(key);
            else existingKeys.get(ev.entity_type)!.add(key);
          }
        } catch {}
      }

      // Classify incoming as new vs conflict
      const conflicts: { entityType: string; key: string; entity: any }[] = [];
      const newEntities: typeof incoming = [];
      for (const item of incoming) {
        const existing = existingKeys.get(item.entityType);
        if (existing?.has(item.key)) conflicts.push(item);
        else newEntities.push(item);
      }

      if (mode === 'preview') {
        const byType: Record<string, { new: number; conflicts: number }> = {};
        for (const item of newEntities) {
          if (!byType[item.entityType]) byType[item.entityType] = { new: 0, conflicts: 0 };
          byType[item.entityType].new++;
        }
        for (const item of conflicts) {
          if (!byType[item.entityType]) byType[item.entityType] = { new: 0, conflicts: 0 };
          byType[item.entityType].conflicts++;
        }
        res.json({
          success: true,
          preview: true,
          total: incoming.length,
          new_count: newEntities.length,
          conflict_count: conflicts.length,
          breakdown: byType,
          sample_conflicts: conflicts.slice(0, 5).map(c => ({ entityType: c.entityType, key: c.key })),
        });
        return;
      }

      // Determine which entities to insert
      const toInsert = mode === 'skip' ? newEntities : incoming;

      const batchId = (receivedAt && !isNaN(new Date(receivedAt).getTime()))
        ? new Date(receivedAt).toISOString()
        : new Date().toISOString();
      const atDate = new Date(batchId);

      const events = toInsert.map(item => ({
        instance_id: req.params.id,
        entity_type: item.entityType,
        operation: 'create' as const,
        payload: JSON.stringify(item.entity),
        received_at: atDate,
      }));

      let imported = 0;
      const BATCH = 500;
      for (let i = 0; i < events.length; i += BATCH) {
        const result = await prisma.syncEvent.createMany({ data: events.slice(i, i + BATCH) });
        imported += result.count;
      }

      res.json({
        success: true,
        imported,
        skipped: mode === 'skip' ? conflicts.length : 0,
        conflict_count: conflicts.length,
        batch_id: batchId,
      });
    } catch (e: any) {
      console.error('[data/import]', e.message);
      res.status(500).json({ success: false, error: e.message });
    }
  }
);

/**
 * DELETE /api/admin/instances/:id/data/import-batch
 * Body: { batchId: string }
 * Undoes an import by deleting all sync_events for this instance with
 * received_at matching the batchId ISO timestamp exactly.
 */
router.delete('/instances/:id/data/import-batch', async (req: Request, res: Response) => {
  try {
    const { batchId } = req.body as { batchId?: string };
    if (!batchId) { res.status(400).json({ success: false, error: 'batchId required' }); return; }
    const batchDate = new Date(batchId);
    if (isNaN(batchDate.getTime())) { res.status(400).json({ success: false, error: 'Invalid batchId' }); return; }

    const instance = await prisma.instance.findUnique({ where: { instance_id: req.params.id }, select: { id: true } });
    if (!instance) { res.status(404).json({ success: false, error: 'Instance not found' }); return; }

    // Delete events with exact received_at match (ISO precision)
    const result = await prisma.syncEvent.deleteMany({
      where: { instance_id: req.params.id, received_at: batchDate },
    });

    res.json({ success: true, deleted: result.count });
  } catch (e: any) {
    console.error('[data/import-batch delete]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── Instance deletion log ────────────────────────────────────────────────────

/**
 * GET /admin/instances/:id/deletion-log
 * Returns the list of data categories this shop has selectively deleted locally.
 */
router.get('/instances/:id/deletion-log', requireAdmin, async (req: Request, res: Response) => {
  const instance = await prisma.instance.findUnique({ where: { instance_id: req.params.id } });
  if (!instance) { res.status(404).json({ success: false, error: 'Instance not found' }); return; }

  let categories: string[] = [];
  try { categories = JSON.parse(instance.deleted_categories || '[]'); } catch {}

  res.json({ success: true, deleted_categories: categories });
});

/**
 * DELETE /admin/instances/:id/deletion-log
 * Resets the deletion log — the next pull-data will include all entity types again.
 */
router.delete('/instances/:id/deletion-log', requireAdmin, async (req: Request, res: Response) => {
  const instance = await prisma.instance.findUnique({ where: { instance_id: req.params.id } });
  if (!instance) { res.status(404).json({ success: false, error: 'Instance not found' }); return; }

  await prisma.instance.update({
    where: { instance_id: req.params.id },
    data: { deleted_categories: '[]' },
  });

  res.json({ success: true, message: 'Deletion log cleared — all data categories will be included on next pull.' });
});

// Multi-device is handled via shared cloud credentials — no separate shop accounts needed.

export default router;
