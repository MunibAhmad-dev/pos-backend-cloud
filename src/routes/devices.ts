/**
 * /api/devices — Multi-device shop group endpoints
 *
 * Flow:
 *  1. Admin creates a ShopAccount (username + password) in the admin panel.
 *  2. Each POS device calls POST /api/devices/login with those credentials.
 *     On success it gets a unique device api_key it stores locally.
 *  3. Every 2 minutes the POS calls POST /api/devices/heartbeat so the admin
 *     panel shows which devices are currently online.
 *  4. Manager devices call GET /api/devices/shop-feed to see recent sales
 *     from ALL devices in the same shop account (cross-device live view).
 */

import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import bcrypt from 'bcryptjs';
import prisma from '../db';

const router = Router();

// ── Middleware: authenticate a shop device by its api_key ─────────────────────
async function requireShopDevice(
  req: Request,
  res: Response,
  next: () => void,
): Promise<void> {
  const token = req.headers.authorization?.replace('Bearer ', '').trim();
  if (!token) {
    res.status(401).json({ success: false, error: 'Missing Authorization header' });
    return;
  }
  const device = await prisma.shopDevice.findUnique({
    where: { api_key: token },
    include: { shop_account: true },
  });
  if (!device || !device.is_active) {
    res.status(401).json({ success: false, error: 'Invalid or revoked device key' });
    return;
  }
  if (!device.shop_account.is_active) {
    res.status(403).json({ success: false, error: 'Shop account is disabled' });
    return;
  }
  (req as any).shopDevice = device;
  next();
}

/**
 * POST /api/devices/login
 *
 * Body: { username, password, device_id, device_name, device_type, device_role,
 *          instance_id?, app_version? }
 *
 * Returns: { api_key, shop_code, shop_name, device_role, device_id }
 *
 * Idempotent — re-logging in with the same device_id refreshes the record and
 * returns the SAME api_key so a reinstalled POS reconnects cleanly.
 */
router.post('/login', async (req: Request, res: Response) => {
  const {
    username, password,
    device_id, device_name = 'Device',
    device_type = 'desktop', device_role = 'sales',
    instance_id = '', app_version = '',
  } = req.body as Record<string, string>;

  if (!username || !password || !device_id) {
    res.status(400).json({ success: false, error: 'username, password and device_id are required' });
    return;
  }

  const account = await prisma.shopAccount.findUnique({ where: { username } });
  if (!account || !account.is_active) {
    res.status(401).json({ success: false, error: 'Invalid credentials' });
    return;
  }

  const valid = await bcrypt.compare(password, account.password_hash);
  if (!valid) {
    res.status(401).json({ success: false, error: 'Invalid credentials' });
    return;
  }

  // Enforce max device cap — but allow re-login from an already-registered device
  const existingDevice = await prisma.shopDevice.findUnique({ where: { device_id } });
  if (!existingDevice) {
    const activeCount = await prisma.shopDevice.count({
      where: { shop_account_id: account.id, is_active: true },
    });
    if (activeCount >= account.max_devices) {
      res.status(403).json({
        success: false,
        error: `Device limit reached (${account.max_devices}). Ask your admin to increase it or revoke an old device.`,
      });
      return;
    }
  }

  let api_key: string;
  if (existingDevice) {
    // Re-login: update metadata, return same key
    api_key = existingDevice.api_key;
    await prisma.shopDevice.update({
      where: { device_id },
      data: {
        device_name, device_type, device_role, app_version,
        instance_id: instance_id || existingDevice.instance_id,
        is_active: true,
        last_heartbeat: new Date(),
      },
    });
  } else {
    api_key = uuidv4();
    await prisma.shopDevice.create({
      data: {
        shop_account_id: account.id,
        device_id,
        instance_id,
        device_name,
        device_type,
        device_role,
        api_key,
        app_version,
        last_heartbeat: new Date(),
      },
    });
  }

  res.json({
    success: true,
    api_key,
    shop_code:   account.shop_code,
    shop_name:   account.shop_name,
    device_role,
    device_name,
    max_devices: account.max_devices,
  });
});

/**
 * POST /api/devices/heartbeat   [shopDeviceAuth]
 *
 * Body: { app_version? }
 * Updates last_heartbeat so admin can track which devices are online.
 */
router.post('/heartbeat', requireShopDevice as any, async (req: Request, res: Response) => {
  const device = (req as any).shopDevice;
  const { app_version } = req.body as { app_version?: string };

  await prisma.shopDevice.update({
    where: { id: device.id },
    data: {
      last_heartbeat: new Date(),
      ...(app_version ? { app_version } : {}),
    },
  });

  res.json({ success: true, ts: new Date().toISOString() });
});

/**
 * GET /api/devices/shop-feed   [shopDeviceAuth]
 *
 * Query: ?since=<ISO> (default: last 24 h)
 *
 * Returns the last 200 sales from OTHER devices in the same shop account.
 * Only devices with an instance_id link (set at login) can appear in the feed.
 * Manager devices use this to show a live cross-device sales view.
 */
router.get('/shop-feed', requireShopDevice as any, async (req: Request, res: Response) => {
  const device      = (req as any).shopDevice;
  const sinceParam  = req.query.since as string | undefined;
  const since       = sinceParam ? new Date(sinceParam) : new Date(Date.now() - 24 * 3600_000);

  // All active devices in the same shop account that have an instance_id
  const siblings = await prisma.shopDevice.findMany({
    where: {
      shop_account_id: device.shop_account_id,
      is_active:       true,
      NOT: { id: device.id }, // exclude self
    },
    select: { instance_id: true, device_name: true, device_role: true },
  });

  const instanceIds = siblings
    .map(d => d.instance_id)
    .filter(id => !!id);

  const deviceNameMap: Record<string, string> = {};
  for (const d of siblings) {
    if (d.instance_id) deviceNameMap[d.instance_id] = d.device_name;
  }

  if (instanceIds.length === 0) {
    res.json({ success: true, data: [], siblings: siblings.length });
    return;
  }

  const sales = await prisma.instanceSale.findMany({
    where: {
      instance_id: { in: instanceIds },
      synced_at:   { gt: since },
    },
    orderBy: { synced_at: 'desc' },
    take: 200,
    include: {
      instance: { select: { store_name: true, branch_name: true } },
    },
  });

  const data = sales.map(s => ({
    id:             s.id,
    sale_id:        s.pos_sale_id,
    instance_id:    s.instance_id,
    device_name:    deviceNameMap[s.instance_id] ?? s.instance.store_name,
    total:          s.total,
    discount:       s.discount,
    payment_method: s.payment_method,
    payment_status: s.payment_status,
    status:         s.status,
    items_count:    s.items_count,
    items_summary:  s.items_summary,
    date_created:   s.date_created,
    synced_at:      s.synced_at.toISOString(),
  }));

  res.json({ success: true, data, siblings: siblings.length });
});

/**
 * GET /api/devices/me   [shopDeviceAuth]
 * Returns this device's shop context — used by POS on startup to verify the key is still valid.
 */
router.get('/me', requireShopDevice as any, (req: Request, res: Response) => {
  const device = (req as any).shopDevice;
  res.json({
    success:     true,
    device_id:   device.device_id,
    device_name: device.device_name,
    device_role: device.device_role,
    shop_code:   device.shop_account.shop_code,
    shop_name:   device.shop_account.shop_name,
    max_devices: device.shop_account.max_devices,
  });
});

export default router;
