import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import prisma from '../db';
import { requireInstance } from '../middleware/instanceAuth';

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

  // New instance — resolve license if provided
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
    success: true,
    instance_id:     inst.instance_id,
    approval_status: inst.approval_status,
    license_key:     inst.license_key || null,
    license_plan:    inst.license_plan,
    license_expiry:  inst.license_expiry,
    license_revoked: inst.license_revoked || 0,
    block_reason:    inst.block_reason || null,
    store_name:      inst.store_name,
  });
});

/**
 * POST /api/instances/heartbeat   [instanceAuth]
 */
router.post('/heartbeat', requireInstance, async (req: Request, res: Response) => {
  const inst = req.instance!;
  const { store_name, total_sales, total_revenue, total_customers, total_products, app_version } = req.body as Record<string, any>;

  await prisma.instance.update({
    where: { instance_id: inst.instance_id },
    data: {
      last_seen:       new Date(),
      store_name:      store_name    || undefined,
      total_sales:     total_sales   != null ? Number(total_sales)   : undefined,
      total_revenue:   total_revenue != null ? Number(total_revenue) : undefined,
      total_customers: total_customers != null ? Number(total_customers) : undefined,
      total_products:  total_products  != null ? Number(total_products)  : undefined,
      app_version:     app_version   || undefined,
    },
  });

  const updated = await prisma.instance.findUnique({
    where:  { instance_id: inst.instance_id },
    select: { approval_status: true, license_plan: true, license_expiry: true, block_reason: true },
  });

  res.json({
    success: true,
    approval_status: updated?.approval_status,
    license_plan:    updated?.license_plan,
    license_expiry:  updated?.license_expiry,
    message: updated?.approval_status === 'blocked' ? (updated.block_reason || 'Account blocked') : null,
  });
});

/**
 * GET /api/instances/notifications   [instanceAuth]
 *
 * Returns unread notifications and marks them read in one transaction.
 */
router.get('/notifications', requireInstance, async (req: Request, res: Response) => {
  const instanceId = req.instance!.instance_id;

  // Find unread active notifications for this instance
  const notifications = await prisma.notification.findMany({
    where: {
      is_active: true,
      OR: [{ target_instance_id: null }, { target_instance_id: instanceId }],
      notification_reads: { none: { instance_id: instanceId } },
    },
    orderBy: { sent_at: 'desc' },
    take:    20,
    select:  { id: true, title: true, body: true, sent_at: true },
  });

  // Mark all as read
  if (notifications.length > 0) {
    await prisma.notificationRead.createMany({
      data:           notifications.map(n => ({ notification_id: n.id, instance_id: instanceId })),
      skipDuplicates: true,
    });
  }

  res.json({ success: true, data: notifications });
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

  // Fallback to instance_sales if no sale events
  const fallbackSales = structured.sales?.length ? [] :
    await prisma.instanceSale.findMany({ where: { instance_id: instanceId }, orderBy: { date_created: 'asc' } });

  res.json({
    exported_at:       new Date().toISOString(),
    instance: {
      store_name:      req.instance!.store_name,
      owner_name:      req.instance!.owner_name,
      owner_mobile:    req.instance!.owner_mobile,
      license_plan:    req.instance!.license_plan,
      approval_status: req.instance!.approval_status,
    },
    products:          structured.products          || [],
    customers:         structured.customers         || [],
    vendors:           structured.vendors           || [],
    purchases:         structured.purchases         || [],
    expenses:          structured.expenses          || [],
    sales:             structured.sales?.length ? structured.sales : fallbackSales,
    sale_items:        structured.sale_items        || [],
    inventory_batches: structured.inventory_batches || [],
    customer_payments: structured.customer_payments || [],
    raw_events_count:  rawEvents.length,
  });
});

export default router;
