import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { Prisma } from '@prisma/client';
import prisma from '../db';
import { requireInstance } from '../middleware/instanceAuth';
import { signMobileToken } from '../middleware/auth';
import '../types';

const router = Router();

/**
 * POST /api/instances/register
 *
 * Idempotent — returns existing api_key if mobile already registered.
 */
router.post('/register', async (req: Request, res: Response) => {
  const {
    instance_id, store_name, owner_name, owner_mobile, owner_email,
    store_address, business_name, license_key, fingerprint, app_version, branch_name,
  } = req.body as Record<string, string>;

  if (!instance_id || !owner_mobile) {
    res.status(400).json({ success: false, error: 'instance_id and owner_mobile are required' });
    return;
  }

  const existing = await prisma.instance.findUnique({ where: { instance_id } });

  if (existing) {
    // Update metadata — only overwrite if the incoming value is non-empty
    await prisma.instance.update({
      where: { instance_id },
      data: {
        store_name:         store_name    || undefined,
        owner_name:         owner_name    || undefined,
        owner_email:        owner_email   || undefined,
        store_address:      store_address || undefined,
        business_name:      business_name || undefined,
        device_fingerprint: fingerprint   || undefined,
        app_version:        app_version   || undefined,
        branch_name:        branch_name   || undefined,
        last_seen:          new Date(),
      },
    });

    return res.json({
      success: true,
      api_key:         existing.api_key,
      approval_status: existing.approval_status,
      license_plan:    existing.license_plan,
      license_expiry:  existing.license_expiry,
      message: 'Instance already registered. api_key returned.',
    });
  }

  // ── Mobile-number fallback ────────────────────────────────────────────────
  // A fresh install generates a NEW instance_id (UUID), so findUnique above
  // won't match the previously-approved record. Avoid creating a duplicate
  // pending entry by looking up the most-recent instance for this mobile number.
  const existingByMobile = await prisma.instance.findFirst({
    where:   { owner_mobile: owner_mobile.trim() },
    orderBy: { created_at: 'desc' },
  });
  if (existingByMobile) {
    await prisma.instance.update({
      where: { instance_id: existingByMobile.instance_id },
      data: {
        store_name:         store_name    || undefined,
        owner_name:         owner_name    || undefined,
        owner_email:        owner_email   || undefined,
        store_address:      store_address || undefined,
        business_name:      business_name || undefined,
        device_fingerprint: fingerprint   || undefined,
        app_version:        app_version   || undefined,
        branch_name:        branch_name   || undefined,
        last_seen:          new Date(),
      },
    });
    return res.json({
      success:         true,
      api_key:         existingByMobile.api_key,
      instance_id:     existingByMobile.instance_id,   // tell client to re-anchor to this ID
      approval_status: existingByMobile.approval_status,
      license_plan:    existingByMobile.license_plan,
      license_expiry:  existingByMobile.license_expiry,
      message:         'Existing instance reconnected via mobile number.',
    });
  }
  // ─────────────────────────────────────────────────────────────────────────

  // Genuinely new instance — resolve license if provided
  const api_key = uuidv4();
  let license_plan   = 'none';
  let license_expiry: string | null = null;

  if (license_key) {
    const lic = await prisma.licenseKey.findFirst({
      where: { license_key, is_active: true },
    });
    if (lic) {
      license_plan   = lic.plan;
      license_expiry = lic.expires_at ?? null;
      await prisma.licenseKey.update({
        where: { license_key },
        data:  { instance_id },
      });
    }
  }

  await prisma.instance.create({
    data: {
      instance_id,
      store_name:         store_name    || '',
      owner_name:         owner_name    || '',
      owner_mobile,
      owner_email:        owner_email   || '',
      store_address:      store_address || '',
      business_name:      business_name || '',
      api_key,
      license_key:        license_key   || '',
      license_plan,
      license_expiry,
      device_fingerprint: fingerprint   || '',
      app_version:        app_version   || '',
      branch_name:        branch_name   || 'Main Branch',
      approval_status:    'pending',
    },
  });

  res.status(201).json({
    success: true,
    api_key,
    approval_status: 'pending',
    license_plan,
    license_expiry,
    message: 'Instance registered. Awaiting admin approval.',
  });
});

/**
 * GET /api/instances/status   [instanceAuth]
 */
router.get('/status', requireInstance, (req: Request, res: Response) => {
  const inst = req.instance!;
  res.json({
    success:          true,
    instance_id:      inst.instance_id,
    approval_status:  inst.approval_status,
    license_key:      inst.license_key || null,
    license_plan:     inst.license_plan,
    license_expiry:   inst.license_expiry,
    license_revoked:  inst.license_revoked || 0,
    block_reason:     inst.block_reason || null,
    store_name:       inst.store_name,
    cloud_blocked:    (inst as any).cloud_blocked    ?? false,
    db_upload_status: (inst as any).db_upload_status ?? 'none',
  });
});

/**
 * POST /api/instances/request-db-upload   [instanceAuth]
 * Body: { note?: string }
 *
 * Store owner asks admin permission to upload their full database.
 * Creates a pending request the admin can approve/reject from the dashboard.
 */
router.post('/request-db-upload', requireInstance, async (req: Request, res: Response) => {
  const inst = req.instance!;
  const { note } = req.body as { note?: string };

  const current = (inst as any).db_upload_status ?? 'none';

  // Already approved — no need to re-request
  if (current === 'approved') {
    res.json({ success: true, db_upload_status: 'approved', message: 'Upload already approved — proceed with the upload.' });
    return;
  }

  await prisma.instance.update({
    where: { instance_id: inst.instance_id },
    data: {
      db_upload_status: 'requested',
      db_upload_note:   note?.trim() || '',
    } as any,
  });

  res.json({
    success:          true,
    db_upload_status: 'requested',
    message:          'Upload request sent. You will be notified when the admin approves it.',
  });
});

/**
 * POST /api/instances/complete-db-upload   [instanceAuth]
 *
 * Called by the POS after a successful upload to reset the request status.
 */
router.post('/complete-db-upload', requireInstance, async (req: Request, res: Response) => {
  const inst = req.instance!;
  await prisma.instance.update({
    where: { instance_id: inst.instance_id },
    data:  { db_upload_status: 'none', db_upload_note: '' } as any,
  });
  res.json({ success: true, db_upload_status: 'none', message: 'Upload marked complete.' });
});

/**
 * POST /api/instances/heartbeat   [instanceAuth]
 */
router.post('/heartbeat', requireInstance, async (req: Request, res: Response) => {
  const inst = req.instance!;
  const { store_name, total_sales, total_revenue, total_customers, total_products, operating_mode, app_version } = req.body as Record<string, any>;

  await prisma.instance.update({
    where: { instance_id: inst.instance_id },
    data: {
      last_seen:       new Date(),
      store_name:      store_name    || undefined,
      total_sales:     total_sales   != null ? Number(total_sales)   : undefined,
      total_revenue:   total_revenue != null ? Number(total_revenue) : undefined,
      total_customers: total_customers != null ? Number(total_customers) : undefined,
      total_products:  total_products  != null ? Number(total_products)  : undefined,
      operating_mode:  operating_mode === 'sales' ? 'sales' : operating_mode === 'full' ? 'full' : undefined,
      app_version:     app_version   || undefined,
    },
  });

  const updated = await prisma.instance.findUnique({
    where:  { instance_id: inst.instance_id },
    select: { approval_status: true, license_plan: true, license_expiry: true,
              block_reason: true, cloud_blocked: true, db_upload_status: true },
  });

  res.json({
    success:          true,
    approval_status:  updated?.approval_status,
    license_plan:     updated?.license_plan,
    license_expiry:   updated?.license_expiry,
    cloud_blocked:    updated?.cloud_blocked    ?? false,
    db_upload_status: (updated as any)?.db_upload_status ?? 'none',
    message: updated?.approval_status === 'blocked'
               ? (updated.block_reason || 'Account blocked')
               : (updated?.cloud_blocked ? (updated.block_reason || 'Cloud sync blocked by administrator') : null),
  });
});

/**
 * GET /api/instances/notifications   [instanceAuth]
 *
 * Returns unread notifications and marks them read in one transaction.
 */
router.get('/notifications', requireInstance, async (req: Request, res: Response) => {
  const instanceId = req.instance!.instance_id;

  const now = new Date();

  // Find unread active notifications — exclude expired ones
  const notifications = await prisma.notification.findMany({
    where: {
      is_active: true,
      OR: [{ target_instance_id: null }, { target_instance_id: instanceId }],
      notification_reads: { none: { instance_id: instanceId } },
      // Show if not expired (expires_at IS NULL means permanent)
      AND: [{ OR: [{ expires_at: null }, { expires_at: { gt: now } }] }],
    },
    orderBy: { sent_at: 'desc' },
    take:    20,
    select:  { id: true, title: true, body: true, sent_at: true, display_type: true, style: true, expires_at: true },
  });

  // Mark all as read
  if (notifications.length > 0) {
    await prisma.notificationRead.createMany({
      data:           notifications.map(n => ({ notification_id: n.id, instance_id: instanceId })),
      skipDuplicates: true,
    });
  }

  // Also return current active marquee notifications (re-send even if read — for display)
  const marquees = await prisma.notification.findMany({
    where: {
      is_active: true,
      display_type: 'marquee',
      OR: [{ target_instance_id: null }, { target_instance_id: instanceId }],
      AND: [{ OR: [{ expires_at: null }, { expires_at: { gt: now } }] }],
    },
    orderBy: { sent_at: 'desc' },
    take: 5,
    select: { id: true, title: true, body: true, sent_at: true, display_type: true, style: true, expires_at: true },
  });

  res.json({ success: true, data: notifications, marquees });
});

/**
 * GET /api/instances/export   [instanceAuth]
 *
 * Returns all synced data for this instance in POS-compatible format.
 */
router.get('/export', requireInstance, async (req: Request, res: Response) => {
  const instanceId = req.instance!.instance_id;

  const rawEvents = await prisma.syncEvent.findMany({
    where:   { instance_id: instanceId },
    orderBy: { id: 'asc' },
  });

  // Deduplicate — latest state wins, deletes remove the entry
  const entityMap: Record<string, Map<string, any>> = {};
  for (const event of rawEvents) {
    const type = event.entity_type;
    if (!entityMap[type]) entityMap[type] = new Map();
    let payload: any = null;
    try { payload = JSON.parse(event.payload); } catch { continue; }
    if (!payload) continue;
    const key = String(payload?.id ?? payload?.barcode ?? event.id);
    if (event.operation === 'delete') entityMap[type].delete(key);
    else entityMap[type].set(key, payload);
  }

  const structured: Record<string, any[]> = {};
  for (const [type, items] of Object.entries(entityMap)) {
    structured[type] = Array.from(items.values());
  }

  // ── Fallbacks for data that may exist in flattened tables even without full sync events ──
  const fallbackSales = structured.sale?.length ? [] :
    await prisma.instanceSale.findMany({ where: { instance_id: instanceId }, orderBy: { date_created: 'asc' } });

  // Inventory batches: try from separate events first; if missing, extract from purchase payloads
  let invBatches: any[] = structured.inventory_batch || [];
  if (invBatches.length === 0 && (structured.purchase || []).length > 0) {
    for (const pur of structured.purchase || []) {
      if (Array.isArray((pur as any).items)) {
        for (const b of (pur as any).items) invBatches.push(b);
      }
    }
  }

  // Settings: use synced settings_info if available, otherwise use instance fields
  const settingsRow: any = (structured.settings || [])[0] || null;

  res.json({
    exported_at:            new Date().toISOString(),
    // ── Settings (store info) ────────────────────────────────────────────────
    // Returned as a 1-row array so import-data handler processes it like a table
    settings: settingsRow
      ? [{ id: 1, ...settingsRow }]
      : [{
          id: 1,
          store_name:      req.instance!.store_name,
          owner_full_name: req.instance!.owner_name,
          owner_mobile:    req.instance!.owner_mobile,
          store_phone:     req.instance!.owner_mobile,
          business_name:   req.instance!.store_name,
        }],
    // ── Core ────────────────────────────────────────────────────────────────
    products:               structured.product          || [],
    customers:              structured.customer         || [],
    vendors:                structured.vendor           || [],
    employees:              structured.employee         || [],
    // ── Sales ───────────────────────────────────────────────────────────────
    sales:                  structured.sale?.length     ? structured.sale : fallbackSales,
    sale_items:             structured.sale_item        || [],
    sale_returns:           structured.sale_return      || [],
    sale_return_items:      structured.sale_return_item || [],
    // ── Purchases & Stock ────────────────────────────────────────────────────
    purchases:              structured.purchase         || [],
    inventory_batches:      invBatches,
    purchase_returns:       structured.purchase_return  || [],
    purchase_return_items:  structured.purchase_return_item || [],
    stock_adjustments:      structured.stock_adjustment || [],
    // ── Payments ────────────────────────────────────────────────────────────
    customer_payments:      structured.customer_payment || [],
    vendor_payments:        structured.vendor_payment   || [],
    // ── Finance ─────────────────────────────────────────────────────────────
    expenses:               structured.expense          || [],
    accounts:               structured.account          || [],
    account_txns:           structured.account_txn      || [],
    registers:              structured.register         || [],
    financial_transactions: structured.financial_transaction || [],
    // ── History ─────────────────────────────────────────────────────────────
    entity_history:         structured.entity_history || [],
    // ── Meta ────────────────────────────────────────────────────────────────
    raw_events_count:       rawEvents.length,
  });
});

// ─── Branch listing (instance-authenticated) ─────────────────────────────────

/**
 * GET /api/instances/branches   [instanceAuth]
 *
 * Returns all child instances (branches) that registered under this parent.
 * Used by the local POS Branches page to show linked branch devices.
 */
router.get('/branches', requireInstance, async (req: Request, res: Response) => {
  const instanceId = req.instance!.instance_id;

  const branches = await prisma.instance.findMany({
    where:   { parent_instance_id: instanceId } as any,
    orderBy: { created_at: 'desc' },
    select: {
      instance_id:    true,
      store_name:     true,
      branch_name:    true,
      branch_code:    true,
      owner_mobile:   true,
      approval_status:true,
      last_seen:      true,
      app_version:    true,
      total_sales:    true,
      total_revenue:  true,
    } as any,
  });

  res.json({ success: true, data: branches, total: branches.length });
});

/**
 * GET /api/instances/parent   [instanceAuth]
 *
 * For a branch instance — returns the parent's basic info.
 * Returns null data if this instance has no parent.
 */
router.get('/parent', requireInstance, async (req: Request, res: Response) => {
  const parentId = (req.instance as any).parent_instance_id;

  if (!parentId) {
    res.json({ success: true, data: null });
    return;
  }

  const parent = await prisma.instance.findUnique({
    where: { instance_id: parentId },
    select: {
      instance_id:    true,
      store_name:     true,
      branch_name:    true,
      owner_mobile:   true,
      approval_status:true,
      last_seen:      true,
    } as any,
  });

  res.json({ success: true, data: parent ?? null });
});

// ─── Cloud entity counts ─────────────────────────────────────────────────────
/**
 * GET /api/instances/cloud-counts   [instanceAuth]
 *
 * Returns the count of DISTINCT entities in the cloud for each entity type.
 * Uses DISTINCT deduplication (latest event wins per entity id) so the number
 * matches what "Fetch from Cloud" would actually restore.
 */
router.get('/cloud-counts', requireInstance, async (req: Request, res: Response) => {
  const instanceId = req.instance!.instance_id;

  // Count distinct entity IDs per type (payload->>'id' as the dedup key)
  const rows = await prisma.$queryRaw<Array<{ entity_type: string; distinct_count: bigint }>>(
    Prisma.sql`
      SELECT entity_type,
             COUNT(DISTINCT (payload::jsonb)->>'id') AS distinct_count
      FROM   sync_events
      WHERE  instance_id = ${instanceId}
        AND  operation   != 'delete'
      GROUP  BY entity_type
    `
  );

  const counts: Record<string, number> = {};
  for (const row of rows) {
    counts[row.entity_type] = Number(row.distinct_count ?? 0);
  }

  res.json({ success: true, data: counts });
});

// ─── Sync Status (for POS Settings "What's backed up") ───────────────────────
/**
 * GET /api/instances/sync-status   [instanceAuth]
 *
 * Returns a breakdown of what's been synced to the cloud vs what's still local.
 * The POS Settings page uses this to show "X products synced, Y pending" etc.
 */
router.get('/sync-status', requireInstance, async (req: Request, res: Response) => {
  const instanceId = req.instance!.instance_id;

  // Count distinct entity types that have been synced
  const syncedCounts = await prisma.syncEvent.groupBy({
    by:        ['entity_type'],
    where:     { instance_id: instanceId },
    _count:    { _all: true },
  });

  const syncedByType: Record<string, number> = {};
  for (const row of syncedCounts) {
    syncedByType[row.entity_type] = row._count._all;
  }

  const lastEvent = await prisma.syncEvent.findFirst({
    where:   { instance_id: instanceId },
    orderBy: { received_at: 'desc' },
    select:  { received_at: true },
  });

  const salesCount = await prisma.instanceSale.count({ where: { instance_id: instanceId } });

  res.json({
    success: true,
    data: {
      instance_id:    instanceId,
      last_synced_at: lastEvent?.received_at ?? null,
      synced_sales:   salesCount,
      by_entity:      syncedByType,
      total_events:   Object.values(syncedByType).reduce((s, v) => s + v, 0),
    },
  });
});

// ─── Mobile Token Exchange ────────────────────────────────────────────────────
/**
 * POST /api/instances/mobile-token   [instanceAuth]
 *
 * Called by the POS app (or from the mobile app's "Sign in with store" flow).
 * Returns a long-lived JWT scoped to this instance for mobile app access.
 *
 * Requirements:
 *  - Instance must be approved
 *  - Admin must have enabled mobile_access for this instance
 *
 * The POS app calls this after the admin enables mobile access, saves the token
 * to local settings, and shows it to the store owner in the Settings screen.
 *
 * The mobile app can then use this token directly as a "sign in with store" credential.
 */
router.post('/mobile-token', requireInstance, async (req: Request, res: Response) => {
  const inst = req.instance!;

  // pending = waiting for admin to approve the store
  if (inst.approval_status === 'pending') {
    res.status(403).json({
      success:   false,
      error:     'pending',
      message:   'Your store is pending approval. Please contact OsaTech admin to approve your store first.',
    });
    return;
  }

  // Fetch latest mobile_access flag fresh from DB (admin may have just toggled it)
  const row = await prisma.instance.findUnique({
    where:  { instance_id: inst.instance_id },
    select: { mobile_access: true, store_name: true, owner_mobile: true, approval_status: true },
  });

  if (!row) {
    res.status(404).json({ success: false, error: 'Instance not found' });
    return;
  }

  if (!row.mobile_access) {
    res.status(403).json({
      success: false,
      error:   'mobile_not_enabled',
      message: 'Mobile app access is not enabled for your store. Contact OsaTech admin to enable it from the admin panel.',
    });
    return;
  }

  const token = signMobileToken({
    instance_id:  inst.instance_id,
    store_name:   row.store_name   || inst.instance_id,
    owner_mobile: row.owner_mobile || '',
    scope:        'mobile',
  });

  res.json({
    success: true,
    mobile_token: token,
    instance_id:  inst.instance_id,
    store_name:   row.store_name,
    // Tell the mobile app what to display on the login screen
    login_hint:   `Sign in as: ${row.store_name || inst.instance_id}`,
  });
});

/**
 * GET /api/instances/mobile-status   [instanceAuth]
 *
 * Lightweight endpoint the POS app polls to check if mobile access was
 * enabled/disabled since the last check.
 */
router.get('/mobile-status', requireInstance, async (req: Request, res: Response) => {
  const inst = req.instance!;
  const row = await prisma.instance.findUnique({
    where:  { instance_id: inst.instance_id },
    select: { mobile_access: true },
  });
  res.json({ success: true, mobile_access: !!row?.mobile_access });
});

/**
 * GET /api/instances/dashboard   [instanceAuth]
 *
 * Lightweight dashboard KPIs for this store only.
 */
router.get('/dashboard', requireInstance, async (req: Request, res: Response) => {
  const instanceId = req.instance!.instance_id;
  const inst = req.instance!;

  // Sales from instance_sales table (fast)
  const allSales = await prisma.instanceSale.findMany({
    where: { instance_id: instanceId },
    select: { total: true, date_created: true },
  });

  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const todayRevenue = allSales
    .filter(s => s.date_created && new Date(s.date_created) >= todayStart)
    .reduce((sum, s) => sum + Number(s.total || 0), 0);

  const monthRevenue = allSales
    .filter(s => s.date_created && new Date(s.date_created) >= monthStart)
    .reduce((sum, s) => sum + Number(s.total || 0), 0);

  const totalRevenue = allSales.reduce((sum, s) => sum + Number(s.total || 0), 0);
  const totalSales = allSales.length;

  // Counts from sync_events
  const counts = await prisma.syncEvent.groupBy({
    by: ['entity_type'],
    where: { instance_id: instanceId, operation: { not: 'delete' } },
    _count: { _all: true },
  });
  const countMap: Record<string, number> = {};
  for (const c of counts) countMap[c.entity_type] = c._count._all;

  res.json({
    success: true,
    data: {
      store_name:      inst.store_name,
      approval_status: inst.approval_status,
      license_plan:    inst.license_plan,
      license_expiry:  inst.license_expiry,
      today_revenue:   todayRevenue,
      month_revenue:   monthRevenue,
      total_revenue:   totalRevenue,
      total_sales:     totalSales,
      total_products:  inst.total_products  ?? countMap['product']  ?? 0,
      total_customers: inst.total_customers ?? countMap['customer'] ?? 0,
    },
  });
});

/**
 * GET /api/instances/analytics   [instanceAuth]
 * Query: date_from, date_to (ISO strings, optional)
 *
 * Store-scoped analytics: sales trend, top products, P&L.
 */
router.get('/analytics', requireInstance, async (req: Request, res: Response) => {
  const instanceId = req.instance!.instance_id;
  const { date_from, date_to } = req.query as Record<string, string>;

  const from = date_from ? new Date(date_from) : new Date(Date.now() - 30 * 86400000);
  const to   = date_to   ? new Date(date_to)   : new Date();

  // Sales by day — date_created is string|null so filter nulls and use string comparison
  const sales = await prisma.instanceSale.findMany({
    where: {
      instance_id: instanceId,
      date_created: { gte: from.toISOString(), lte: to.toISOString() },
    },
    select: { total: true, date_created: true },
    orderBy: { date_created: 'asc' },
  });

  const salesByDayMap: Record<string, { revenue: number; count: number }> = {};
  for (const s of sales) {
    if (!s.date_created) continue;
    const day = s.date_created.slice(0, 10);
    if (!salesByDayMap[day]) salesByDayMap[day] = { revenue: 0, count: 0 };
    salesByDayMap[day].revenue += Number(s.total || 0);
    salesByDayMap[day].count   += 1;
  }
  const salesByDay = Object.entries(salesByDayMap).map(([day, v]) => ({ day, ...v }));

  // Product price/name lookup (sale_item lines often carry no line total, so
  // revenue must be derived from quantity × the product's price).
  const productInfoEvents = await prisma.syncEvent.findMany({
    where: { instance_id: instanceId, entity_type: 'product', operation: { not: 'delete' } },
    select: { payload: true },
  });
  const priceById: Record<string, number> = {};
  const costById: Record<string, number> = {};
  const nameById: Record<string, string> = {};
  for (const e of productInfoEvents) {
    try {
      const p = JSON.parse(e.payload) as any;
      const id = String(p.id);
      priceById[id] = Number(p.price ?? p.sale_price ?? 0);
      costById[id]  = Number(p.purchase_price ?? p.cost_price ?? p.cost ?? 0);
      nameById[id]  = p.name ?? p.product_name ?? id;
    } catch { continue; }
  }

  // Top products from sale_item events
  const productEvents = await prisma.syncEvent.findMany({
    where: { instance_id: instanceId, entity_type: 'sale_item' },
    select: { payload: true },
  });

  const productMap: Record<string, { name: string; quantity: number; revenue: number }> = {};
  for (const e of productEvents) {
    try {
      const p = JSON.parse(e.payload) as any;
      const pid = String(p.product_id ?? '');
      const key = pid || String(p.product_name || p.name || '');
      if (!key) continue;
      const qty = Number(p.quantity ?? p.qty ?? 0);
      // Prefer an explicit line total; fall back to unit price × qty.
      let lineRev = Number(p.total ?? p.subtotal ?? p.line_total ?? p.total_price ?? p.amount ?? 0);
      if (!lineRev) {
        const unit = Number(p.price ?? p.unit_price ?? p.sale_price ?? priceById[pid] ?? 0);
        lineRev = unit * qty;
      }
      if (!productMap[key]) {
        productMap[key] = { name: p.product_name || p.name || nameById[pid] || key, quantity: 0, revenue: 0 };
      }
      productMap[key].quantity += qty;
      productMap[key].revenue  += lineRev;
    } catch { continue; }
  }
  const topProducts = Object.entries(productMap)
    .map(([id, v]) => ({ product_id: id, ...v }))
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 10);

  // Expenses from sync_events (total + per-day for the P&L graph)
  const expenseEvents = await prisma.syncEvent.findMany({
    where: { instance_id: instanceId, entity_type: 'expense', operation: { not: 'delete' } },
    select: { payload: true },
  });
  let totalExpenses = 0;
  const expenseByDayMap: Record<string, number> = {};
  for (const e of expenseEvents) {
    try {
      const x = JSON.parse(e.payload) as any;
      const amt = Number(x.amount || 0);
      totalExpenses += amt;
      const day = String(x.date_added ?? x.date ?? x.created_at ?? '').slice(0, 10);
      if (day) expenseByDayMap[day] = (expenseByDayMap[day] || 0) + amt;
    } catch { continue; }
  }
  const expensesByDay = Object.entries(expenseByDayMap).map(([day, amount]) => ({ day, amount }));

  const totalRevenue = sales.reduce((sum, s) => sum + Number(s.total || 0), 0);

  res.json({
    success: true,
    data: {
      salesByDay,
      expensesByDay,
      topProducts,
      totals: {
        revenue:  totalRevenue,
        sales:    sales.length,
        expenses: totalExpenses,
        profit:   totalRevenue - totalExpenses,
      },
    },
  });
});

export default router;
