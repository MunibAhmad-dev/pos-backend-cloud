import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import prisma from '../db';
import { requireAdmin } from '../middleware/auth';
import '../types';

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

function calculateInventoryStats(products: any[]) {
  return products.reduce(
    (acc, product) => {
      const stock = Math.max(0, getFirstNumber(product, [
        'stock',
        'quantity',
        'qty',
        'current_stock',
        'stock_quantity',
        'available_stock',
      ]));
      const cost = getFirstNumber(product, [
        'purchase_price',
        'cost_price',
        'buying_price',
        'wholesale_price',
        'unit_cost',
        'cost',
      ]);
      const salePrice = getFirstNumber(product, ['price', 'sale_price', 'selling_price', 'retail_price']);
      const valueAtCost = stock * cost;
      const valueAtSale = stock * salePrice;

      acc.totalStock += stock;
      acc.stockValue += valueAtCost;
      acc.retailValue += valueAtSale;
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

// ─── Export-all helper ────────────────────────────────────────────────────────
// Maps singular entity_type (used in sync_events) → plural SQLite table name.
// Must be kept in sync with full-resync entity types in main.ts.
const ENTITY_TO_TABLE: Record<string, string> = {
  // Core
  product:               'products',
  customer:              'customers',
  vendor:                'vendors',
  employee:              'employees',
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
    const dateTo   = `${date_to} 23:59:59`;
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
        WHERE date_created >= ${dateFrom} AND date_created <= ${dateTo}
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

  const [recentEvents, salesStats, products] = await Promise.all([
    prisma.syncEvent.findMany({
      where:   { instance_id: req.params.id },
      orderBy: { id: 'desc' },
      take:    100,
      select:  { id: true, entity_type: true, operation: true, received_at: true },
    }),
    prisma.instanceSale.aggregate({
      where:   { instance_id: req.params.id },
      _count:  { id: true },
      _sum:    { total: true },
      _max:    { date_created: true },
    }),
    parseEntityFromSync(req.params.id, 'product'),
  ]);

  const inventoryStats = calculateInventoryStats(products);

  // Strip password_hash from the payload — never expose it; send a boolean flag instead
  const { password_hash, ...instanceSafe } = instance as any;

  res.json({
    success: true,
    data: {
      instance: { ...instanceSafe, has_password: !!(password_hash) },
      recentEvents,
      inventoryStats,
      salesStats: {
        total_synced_sales: salesStats._count.id,
        synced_revenue:     salesStats._sum.total,
        last_sale_date:     salesStats._max.date_created,
      },
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
      data:  { password_hash: hash },
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
    where.date_created = { gte: date_from, lte: `${date_to} 23:59:59` };
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
  expenses:  ['expense', 'employee'],
  settings:  ['settings'],
};

// entity_type → table name mapping (singular → plural)
const ENTITY_TABLE: Record<string, string> = {
  product: 'products', inventory_batch: 'inventory_batches', stock_adjustment: 'stock_adjustments',
  sale: 'sales', sale_item: 'sale_items',
  customer: 'customers', vendor: 'vendors', employee: 'employees',
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

  // Always return instance-level fields as fallback
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
      // ── From synced settings (only available if POS uploaded full data) ───
      store_phone:     syncedSettings?.store_phone     || instance.owner_mobile || null,
      receipt_footer:  syncedSettings?.receipt_footer  || null,
      branch_name:     instance.branch_name,
      license_plan:    instance.license_plan,
      license_expiry:  instance.license_expiry,
      app_version:     instance.app_version,
      last_seen:       instance.last_seen,
      synced_from_pos: !!syncedSettings,
    },
  });
});

// ── Products / customers / vendors / purchases / expenses / loans ──────────────
router.get('/instances/:id/products', async (req: Request, res: Response) => {
  const exists = await prisma.instance.findUnique({ where: { instance_id: req.params.id }, select: { id: true } });
  if (!exists) { res.status(404).json({ success: false, error: 'Instance not found' }); return; }
  const products = (await parseEntityFromSync(req.params.id, 'product'))
    .map((product) => {
      const stock = Math.max(0, getFirstNumber(product, ['stock', 'quantity', 'qty', 'current_stock', 'stock_quantity', 'available_stock']));
      const cost = getFirstNumber(product, ['purchase_price', 'cost_price', 'buying_price', 'wholesale_price', 'unit_cost', 'cost']);
      const salePrice = getFirstNumber(product, ['price', 'sale_price', 'selling_price', 'retail_price']);
      return {
        ...product,
        stock_value: Math.round(stock * cost * 100) / 100,
        retail_stock_value: Math.round(stock * salePrice * 100) / 100,
      };
    })
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  res.json({ success: true, data: products, total: products.length });
});

router.get('/instances/:id/customers', async (req: Request, res: Response) => {
  const exists = await prisma.instance.findUnique({ where: { instance_id: req.params.id }, select: { id: true } });
  if (!exists) { res.status(404).json({ success: false, error: 'Instance not found' }); return; }

  const [customers, sales, payments] = await Promise.all([
    parseEntityFromSync(req.params.id, 'customer'),
    parseEntityFromSync(req.params.id, 'sale'),
    parseEntityFromSync(req.params.id, 'customer_payment'),
  ]);

  const salesMap = new Map<string, number>();
  for (const s of sales) {
    const cid = String(s.customer_id ?? '');
    if (!cid || cid === 'null' || cid === '0') continue;
    if (s.status === 'Cancelled' || s.status === 'cancelled') continue;
    salesMap.set(cid, (salesMap.get(cid) ?? 0) + (parseFloat(s.total) || 0));
  }
  const payMap = new Map<string, number>();
  for (const p of payments) {
    const cid = String(p.customer_id ?? '');
    if (!cid || cid === 'null') continue;
    payMap.set(cid, (payMap.get(cid) ?? 0) + (parseFloat(p.amount) || 0));
  }

  const items = customers.map((c: any) => {
    const cid = String(c.id ?? '');
    return { ...c, balance: Math.round(Math.max(0, (salesMap.get(cid) ?? 0) - (payMap.get(cid) ?? 0)) * 100) / 100 };
  }).sort((a: any, b: any) => (b.balance - a.balance) || (a.name || '').localeCompare(b.name || ''));

  res.json({ success: true, data: items, total: items.length });
});

router.get('/instances/:id/vendors', async (req: Request, res: Response) => {
  const exists = await prisma.instance.findUnique({ where: { instance_id: req.params.id }, select: { id: true } });
  if (!exists) { res.status(404).json({ success: false, error: 'Instance not found' }); return; }

  const [vendors, purchases, payments] = await Promise.all([
    parseEntityFromSync(req.params.id, 'vendor'),
    parseEntityFromSync(req.params.id, 'purchase'),
    parseEntityFromSync(req.params.id, 'vendor_payment'),
  ]);

  const purchMap = new Map<string, number>();
  for (const p of purchases) {
    const vid = String(p.vendor_id ?? '');
    if (!vid || vid === 'null' || vid === '0') continue;
    purchMap.set(vid, (purchMap.get(vid) ?? 0) + (parseFloat(p.total) || 0));
  }
  const payMap = new Map<string, number>();
  for (const p of payments) {
    const vid = String(p.vendor_id ?? '');
    if (!vid || vid === 'null') continue;
    payMap.set(vid, (payMap.get(vid) ?? 0) + (parseFloat(p.amount) || 0));
  }

  const items = vendors.map((v: any) => {
    const vid = String(v.id ?? '');
    return { ...v, balance: Math.round(Math.max(0, (purchMap.get(vid) ?? 0) - (payMap.get(vid) ?? 0)) * 100) / 100 };
  }).sort((a: any, b: any) => (b.balance - a.balance) || (a.name || '').localeCompare(b.name || ''));

  res.json({ success: true, data: items, total: items.length });
});

router.get('/instances/:id/purchases', async (req: Request, res: Response) => {
  const exists = await prisma.instance.findUnique({ where: { instance_id: req.params.id }, select: { id: true } });
  if (!exists) { res.status(404).json({ success: false, error: 'Instance not found' }); return; }

  const [purchases, vendors] = await Promise.all([
    parseEntityFromSync(req.params.id, 'purchase'),
    parseEntityFromSync(req.params.id, 'vendor'),
  ]);

  // Build vendor lookup: id → name
  const vendorById = new Map<string, string>(
    vendors.map((v: any) => [String(v.id ?? ''), v.name || '—'])
  );

  const enriched = purchases
    .map((p: any) => ({
      ...p,
      // Normalise date: POS uses date_created, UI column expects 'date'
      date:        p.date_created || p.date_added || p.date || null,
      // Resolve vendor name from separate vendor sync events
      vendor_name: vendorById.get(String(p.vendor_id ?? '')) || p.vendor_name || '—',
    }))
    .sort((a: any, b: any) => (b.date || '').localeCompare(a.date || ''));

  res.json({ success: true, data: enriched, total: enriched.length });
});

router.get('/instances/:id/expenses', async (req: Request, res: Response) => {
  const exists = await prisma.instance.findUnique({ where: { instance_id: req.params.id }, select: { id: true } });
  if (!exists) { res.status(404).json({ success: false, error: 'Instance not found' }); return; }

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

  res.json({ success: true, data: expenseRows, employees: employeeRows,
             total: expenseRows.length, totalEmployees: employeeRows.length });
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

  const [customers, sales, customerPayments, vendors, purchases, vendorPayments] = await Promise.all([
    parseEntityFromSync(req.params.id, 'customer'),
    parseEntityFromSync(req.params.id, 'sale'),
    parseEntityFromSync(req.params.id, 'customer_payment'),
    parseEntityFromSync(req.params.id, 'vendor'),
    parseEntityFromSync(req.params.id, 'purchase'),
    parseEntityFromSync(req.params.id, 'vendor_payment'),
  ]);

  const salesByC = new Map<string, number>();
  for (const s of sales) {
    const cid = String(s.customer_id ?? '');
    if (!cid || cid === 'null' || cid === '0') continue;
    if (s.status === 'Cancelled' || s.status === 'cancelled') continue;
    salesByC.set(cid, (salesByC.get(cid) ?? 0) + (parseFloat(s.total) || 0));
  }
  const cpByC = new Map<string, number>();
  for (const p of customerPayments) {
    const cid = String(p.customer_id ?? '');
    if (!cid || cid === 'null') continue;
    cpByC.set(cid, (cpByC.get(cid) ?? 0) + (parseFloat(p.amount) || 0));
  }

  const customerLoans = customers
    .map((c: any) => {
      const cid   = String(c.id ?? '');
      const total = salesByC.get(cid) ?? 0;
      const paid  = cpByC.get(cid)   ?? 0;
      return {
        ...c,
        customer_id:   c.id,
        customer_name: c.name || c.customer_name || '—',
        total_amount:  Math.round(total * 100) / 100,
        paid_amount:   Math.round(paid  * 100) / 100,
        balance:       Math.round(Math.max(0, total - paid) * 100) / 100,
      };
    })
    .filter((c: any) => c.balance > 0)
    .sort((a: any, b: any) => b.balance - a.balance);

  const purchByV = new Map<string, number>();
  for (const p of purchases) {
    const vid = String(p.vendor_id ?? '');
    if (!vid || vid === 'null' || vid === '0') continue;
    purchByV.set(vid, (purchByV.get(vid) ?? 0) + (parseFloat(p.total) || 0));
  }
  const vpByV = new Map<string, number>();
  for (const p of vendorPayments) {
    const vid = String(p.vendor_id ?? '');
    if (!vid || vid === 'null') continue;
    vpByV.set(vid, (vpByV.get(vid) ?? 0) + (parseFloat(p.amount) || 0));
  }

  const vendorLoans = vendors
    .map((v: any) => {
      const vid   = String(v.id ?? '');
      const total = purchByV.get(vid) ?? 0;
      const paid  = vpByV.get(vid)   ?? 0;
      return {
        ...v,
        vendor_id:   v.id,
        vendor_name: v.name || v.vendor_name || '—',
        total_amount: Math.round(total * 100) / 100,
        paid_amount:  Math.round(paid  * 100) / 100,
        balance:      Math.round(Math.max(0, total - paid) * 100) / 100,
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

// ── Analytics ─────────────────────────────────────────────────────────────────
router.get('/analytics', async (req: Request, res: Response) => {
  const { date_from, date_to } = req.query as Record<string, string>;
  const hasDateRange = !!(date_from && date_to);

  // Revenue by instance (top 10)
  let revenueByInstance: any[];
  if (hasDateRange) {
    revenueByInstance = await prisma.$queryRaw<any[]>(Prisma.sql`
      SELECT i.instance_id, i.store_name, i.owner_mobile,
             COALESCE(s.total_revenue, 0) AS total_revenue,
             COALESCE(s.total_sales, 0)   AS total_sales,
             i.total_customers, i.total_products
      FROM instances i
      LEFT JOIN (
        SELECT instance_id, SUM(total)::float AS total_revenue, COUNT(*)::int AS total_sales
        FROM instance_sales
        WHERE DATE(CAST(date_created AS TIMESTAMP)) BETWEEN ${date_from}::date AND ${date_to}::date
        GROUP BY instance_id
      ) s ON s.instance_id = i.instance_id
      WHERE i.approval_status = 'approved'
      ORDER BY COALESCE(s.total_revenue, 0) DESC LIMIT 10
    `);
  } else {
    revenueByInstance = await prisma.instance.findMany({
      where:   { approval_status: 'approved' },
      orderBy: { total_revenue: 'desc' },
      take:    10,
      select:  { instance_id: true, store_name: true, owner_mobile: true, total_revenue: true, total_sales: true, total_customers: true, total_products: true },
    });
  }

  // Activity distribution by last_seen recency
  const activityDistribution = await prisma.$queryRaw<any[]>(Prisma.sql`
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
    GROUP BY period
    ORDER BY CASE period WHEN 'Today' THEN 1 WHEN 'This Week' THEN 2 WHEN 'This Month' THEN 3 WHEN 'Older' THEN 4 ELSE 5 END
  `);

  // Plan distribution
  const planDistribution = await prisma.$queryRaw<any[]>(Prisma.sql`
    SELECT COALESCE(NULLIF(license_plan,''),'none') AS plan, COUNT(*)::int AS count
    FROM instances WHERE approval_status = 'approved'
    GROUP BY plan ORDER BY count DESC
  `);

  // Status distribution
  const statusDistribution = await prisma.$queryRaw<any[]>(Prisma.sql`
    SELECT approval_status AS status, COUNT(*)::int AS count
    FROM instances GROUP BY approval_status
  `);

  // Sales trend by day
  // Strategy: try the requested date range first. If that returns 0 rows, automatically
  // expand to show ALL available data so the chart is never blank when data exists.
  const salesDayQ = (whereClause: Prisma.Sql) => prisma.$queryRaw<any[]>(Prisma.sql`
    SELECT TO_CHAR(CAST(date_created AS TIMESTAMP), 'YYYY-MM-DD') AS day,
           COUNT(*)::int                                           AS sales_count,
           COALESCE(SUM(total), 0)::float                         AS revenue,
           COUNT(DISTINCT instance_id)::int                       AS active_stores
    FROM instance_sales
    WHERE date_created IS NOT NULL ${whereClause}
    GROUP BY day ORDER BY day
  `);

  let salesByDay: any[];
  if (hasDateRange) {
    salesByDay = await salesDayQ(
      Prisma.sql`AND DATE(CAST(date_created AS TIMESTAMP)) BETWEEN ${date_from}::date AND ${date_to}::date`
    );
    // If selected range is empty, fall back to last 90 days, then all-time
    if (salesByDay.length === 0) {
      salesByDay = await salesDayQ(
        Prisma.sql`AND CAST(date_created AS TIMESTAMP) >= NOW() - INTERVAL '90 days'`
      );
    }
    if (salesByDay.length === 0) {
      salesByDay = await salesDayQ(Prisma.sql``);   // all-time fallback
    }
  } else {
    salesByDay = await salesDayQ(
      Prisma.sql`AND CAST(date_created AS TIMESTAMP) >= NOW() - INTERVAL '30 days'`
    );
    if (salesByDay.length === 0) {
      salesByDay = await salesDayQ(Prisma.sql``);
    }
  }

  // Top entity types by event count
  const topEntityTypes = await prisma.$queryRaw<any[]>(Prisma.sql`
    SELECT entity_type, COUNT(*)::int AS event_count
    FROM sync_events GROUP BY entity_type ORDER BY event_count DESC
  `);

  // Top products from items_summary
  const recentSummaries = await prisma.instanceSale.findMany({
    where:  { items_summary: { not: '' } },
    select: { items_summary: true },
  });
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

  // Global totals
  const totalsAgg = await prisma.instance.aggregate({
    where:  { approval_status: 'approved' },
    _sum:   { total_customers: true, total_products: true, total_sales: true, total_revenue: true },
  });

  const vendorTotalRow = await prisma.$queryRaw<[{ cnt: bigint }]>(Prisma.sql`
    SELECT COUNT(DISTINCT (payload::jsonb)->>'id' || instance_id)::int AS cnt
    FROM sync_events WHERE entity_type = 'vendor' AND operation = 'create'
  `);

  // Profit & Loss by month — all-time fallback when date range has no data
  let plRevRows: any[], plExpRows: any[];
  const plRevAllTime = () => prisma.$queryRaw<any[]>(Prisma.sql`
    SELECT TO_CHAR(CAST(date_created AS TIMESTAMP), 'YYYY-MM') AS month,
           COALESCE(SUM(total), 0)::float AS revenue
    FROM instance_sales WHERE date_created IS NOT NULL
    GROUP BY month ORDER BY month
  `);
  const plExpAllTime = () => prisma.$queryRaw<any[]>(Prisma.sql`
    SELECT TO_CHAR(received_at, 'YYYY-MM') AS month,
           COALESCE(SUM(CAST((payload::jsonb)->>'amount' AS FLOAT)), 0) AS expenses
    FROM sync_events WHERE entity_type = 'expense' AND operation != 'delete'
    GROUP BY month ORDER BY month
  `);

  if (hasDateRange) {
    [plRevRows, plExpRows] = await Promise.all([
      prisma.$queryRaw<any[]>(Prisma.sql`
        SELECT TO_CHAR(CAST(date_created AS TIMESTAMP), 'YYYY-MM') AS month,
               COALESCE(SUM(total), 0)::float AS revenue
        FROM instance_sales
        WHERE date_created IS NOT NULL
          AND DATE(CAST(date_created AS TIMESTAMP)) BETWEEN ${date_from}::date AND ${date_to}::date
        GROUP BY month ORDER BY month
      `),
      prisma.$queryRaw<any[]>(Prisma.sql`
        SELECT TO_CHAR(received_at, 'YYYY-MM') AS month,
               COALESCE(SUM(CAST((payload::jsonb)->>'amount' AS FLOAT)), 0) AS expenses
        FROM sync_events
        WHERE entity_type = 'expense' AND operation != 'delete'
          AND DATE(received_at) BETWEEN ${date_from}::date AND ${date_to}::date
        GROUP BY month ORDER BY month
      `),
    ]);
    // Fallback to all-time if range returns nothing
    if (plRevRows.length === 0 && plExpRows.length === 0) {
      [plRevRows, plExpRows] = await Promise.all([plRevAllTime(), plExpAllTime()]);
    }
  } else {
    [plRevRows, plExpRows] = await Promise.all([
      prisma.$queryRaw<any[]>(Prisma.sql`
        SELECT TO_CHAR(CAST(date_created AS TIMESTAMP), 'YYYY-MM') AS month,
               COALESCE(SUM(total), 0)::float AS revenue
        FROM instance_sales
        WHERE date_created IS NOT NULL
          AND CAST(date_created AS TIMESTAMP) >= NOW() - INTERVAL '12 months'
        GROUP BY month ORDER BY month
      `),
      prisma.$queryRaw<any[]>(Prisma.sql`
        SELECT TO_CHAR(received_at, 'YYYY-MM') AS month,
               COALESCE(SUM(CAST((payload::jsonb)->>'amount' AS FLOAT)), 0) AS expenses
        FROM sync_events WHERE entity_type = 'expense' AND operation != 'delete'
          AND received_at >= NOW() - INTERVAL '12 months'
        GROUP BY month ORDER BY month
      `),
    ]);
    if (plRevRows.length === 0 && plExpRows.length === 0) {
      [plRevRows, plExpRows] = await Promise.all([plRevAllTime(), plExpAllTime()]);
    }
  }

  const plMerge = new Map<string, { revenue: number; expenses: number }>();
  for (const r of plRevRows)  plMerge.set(r.month, { revenue: Number(r.revenue), expenses: 0 });
  for (const e of plExpRows) {
    const ex = plMerge.get(e.month) ?? { revenue: 0, expenses: 0 };
    plMerge.set(e.month, { ...ex, expenses: Number(e.expenses) });
  }
  const profitLossData = Array.from(plMerge.entries()).sort(([a], [b]) => a.localeCompare(b))
    .map(([month, d]) => ({ month, revenue: Math.round(d.revenue), expenses: Math.round(d.expenses), profit: Math.round(d.revenue - d.expenses) }));

  // Registration trend — ALL TIME grouped by month so the chart is never blank.
  // Includes a running cumulative total so the dashboard can show growth over time.
  const regTrend = await prisma.$queryRaw<any[]>(Prisma.sql`
    SELECT TO_CHAR(created_at, 'YYYY-MM') AS month,
           COUNT(*)::int                  AS count
    FROM instances
    GROUP BY month ORDER BY month
  `);
  let cumulative = 0;
  const registrationsTrend = regTrend.map(r => {
    cumulative += Number(r.count);
    return { month: r.month, newStores: Number(r.count), total: cumulative };
  });

  // Account stats from sync_events
  const [accountTypeDist, accountTxnVolume, accountBalRow, accountTxnRow] = await Promise.all([
    prisma.$queryRaw<any[]>(Prisma.sql`
      SELECT COALESCE(NULLIF((payload::jsonb)->>'type',''), 'other') AS account_type,
             COUNT(*)::int AS count,
             COALESCE(SUM(CAST((payload::jsonb)->>'balance' AS FLOAT)), 0) AS total_balance
      FROM sync_events WHERE entity_type = 'account' AND operation = 'create'
      GROUP BY account_type ORDER BY total_balance DESC
    `),
    prisma.$queryRaw<any[]>(Prisma.sql`
      SELECT COALESCE(NULLIF((payload::jsonb)->>'type',''), 'debit') AS txn_type,
             COUNT(*)::int AS count,
             COALESCE(SUM(CAST((payload::jsonb)->>'amount' AS FLOAT)), 0) AS total_amount
      FROM sync_events WHERE entity_type = 'account_txn' AND operation = 'create'
      GROUP BY txn_type ORDER BY total_amount DESC
    `),
    prisma.$queryRaw<[{ total: number }]>(Prisma.sql`
      SELECT COALESCE(SUM(CAST((payload::jsonb)->>'balance' AS FLOAT)), 0)::float AS total
      FROM sync_events WHERE entity_type = 'account' AND operation = 'create'
    `),
    prisma.$queryRaw<[{ cnt: bigint }]>(Prisma.sql`
      SELECT COUNT(*)::int AS cnt FROM sync_events WHERE entity_type = 'account_txn' AND operation = 'create'
    `),
  ]);

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
        total_vendors:   Number(vendorTotalRow[0]?.cnt          || 0),
      },
      profitLossData,
      registrationsTrend,
      accountStats: {
        typeDist:     accountTypeDist,
        txnVolume:    accountTxnVolume,
        totalBalance: Math.round(Number(accountBalRow[0]?.total || 0)),
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
  } = req.body as {
    title: string; body: string; instance_id?: string;
    duration_hours?: number | null; display_type?: string;
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

export default router;
