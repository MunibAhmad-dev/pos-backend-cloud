/**
 * /api/admin/admins  — sub-admin CRUD (super_admin only)
 * /api/admin/logs    — activity + auth logs
 */
import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { Prisma } from '@prisma/client';
import prisma from '../db';
import { requireAdmin } from '../middleware/auth';

const router = Router();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getIp(req: Request): string {
  return (
    (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
    req.socket.remoteAddress ||
    'unknown'
  );
}

export async function logAction(
  req: Request,
  action: string,
  entity?: string,
  entityId?: string,
  detail?: object,
) {
  if (!req.admin) return;
  try {
    await prisma.adminActivityLog.create({
      data: {
        admin_id:   req.admin.id,
        admin_name: req.admin.username,
        action,
        entity:     entity   ?? null,
        entity_id:  entityId ?? null,
        detail:     detail   ?? Prisma.DbNull,
        ip_address: getIp(req),
      },
    });
  } catch { /* never crash the main request for a log failure */ }
}

function isSuperAdmin(req: Request): boolean {
  return req.admin?.role === 'super_admin';
}

function requireSuper(req: Request, res: Response): boolean {
  if (!isSuperAdmin(req)) {
    res.status(403).json({ success: false, error: 'Super admin access required' });
    return false;
  }
  return true;
}

// ─── Permission definitions ───────────────────────────────────────────────────

export const ALL_PERMISSIONS: Record<string, string> = {
  can_view_instances:    'View stores & instance details',
  can_manage_instances:  'Approve / block / edit stores',
  can_issue_licenses:    'Create & assign license keys',
  can_send_notifications:'Send notifications to stores',
  can_view_analytics:    'View dashboard & analytics',
  can_manage_releases:   'Create & publish app releases',
  can_view_logs:         'View activity & security logs',
};

// ─── List admins ──────────────────────────────────────────────────────────────

router.get('/', requireAdmin, async (req: Request, res: Response) => {
  if (!requireSuper(req, res)) return;
  const admins = await prisma.adminUser.findMany({
    select: {
      id: true, username: true, display_name: true, role: true,
      permissions: true, is_active: true, created_at: true,
      last_login_at: true, created_by_id: true,
      created_by: { select: { username: true } },
    },
    orderBy: { created_at: 'asc' },
  });
  res.json({ success: true, data: admins });
});

// ─── Create sub-admin ─────────────────────────────────────────────────────────

router.post('/', requireAdmin, async (req: Request, res: Response) => {
  if (!requireSuper(req, res)) return;
  const { username, display_name, password, permissions } = req.body as {
    username?: string; display_name?: string; password?: string; permissions?: Record<string, boolean>;
  };
  if (!username?.trim() || !password) {
    res.status(400).json({ success: false, error: 'username and password are required' });
    return;
  }
  if (password.length < 8) {
    res.status(400).json({ success: false, error: 'Password must be at least 8 characters' });
    return;
  }
  const exists = await prisma.adminUser.findUnique({ where: { username: username.trim().toLowerCase() } });
  if (exists) { res.status(409).json({ success: false, error: 'Username already taken' }); return; }

  const hash  = await bcrypt.hash(password, 12);
  const admin = await prisma.adminUser.create({
    data: {
      username:      username.trim().toLowerCase(),
      display_name:  display_name?.trim() || null,
      password_hash: hash,
      role:          'admin',
      permissions:   permissions ?? {},
      is_active:     true,
      created_by_id: req.admin!.id,
    },
  });
  await logAction(req, 'create_admin', 'admin', String(admin.id), { username: admin.username });
  res.status(201).json({ success: true, data: { id: admin.id, username: admin.username } });
});

// ─── Update admin (permissions / display_name / is_active / password) ────────

router.put('/:id', requireAdmin, async (req: Request, res: Response) => {
  if (!requireSuper(req, res)) return;
  const id = Number(req.params.id);
  const target = await prisma.adminUser.findUnique({ where: { id } });
  if (!target) { res.status(404).json({ success: false, error: 'Admin not found' }); return; }
  if (target.role === 'super_admin' && target.id !== req.admin!.id) {
    res.status(403).json({ success: false, error: 'Cannot modify another super admin' }); return;
  }
  const { display_name, permissions, is_active, password } = req.body as {
    display_name?: string; permissions?: Record<string, boolean>; is_active?: boolean; password?: string;
  };
  const data: Record<string, unknown> = {};
  if (display_name !== undefined) data.display_name = display_name.trim() || null;
  if (permissions  !== undefined) data.permissions  = permissions;
  if (is_active    !== undefined) data.is_active     = is_active;
  if (password) {
    if (password.length < 8) { res.status(400).json({ success: false, error: 'Password must be at least 8 characters' }); return; }
    data.password_hash = await bcrypt.hash(password, 12);
  }
  await prisma.adminUser.update({ where: { id }, data });
  await logAction(req, 'update_admin', 'admin', String(id), { fields: Object.keys(data) });
  res.json({ success: true });
});

// ─── Delete sub-admin ─────────────────────────────────────────────────────────

router.delete('/:id', requireAdmin, async (req: Request, res: Response) => {
  if (!requireSuper(req, res)) return;
  const id = Number(req.params.id);
  if (id === req.admin!.id) { res.status(400).json({ success: false, error: 'Cannot delete yourself' }); return; }
  const target = await prisma.adminUser.findUnique({ where: { id } });
  if (!target) { res.status(404).json({ success: false, error: 'Admin not found' }); return; }
  if (target.role === 'super_admin') { res.status(403).json({ success: false, error: 'Cannot delete a super admin' }); return; }
  await prisma.adminUser.delete({ where: { id } });
  await logAction(req, 'delete_admin', 'admin', String(id), { username: target.username });
  res.json({ success: true });
});

// ─── Activity logs ────────────────────────────────────────────────────────────

router.get('/logs/activity', requireAdmin, async (req: Request, res: Response) => {
  if (!isSuperAdmin(req) && !(req.admin as any).permissions?.can_view_logs) {
    res.status(403).json({ success: false, error: 'Access denied' }); return;
  }
  const limit  = Math.min(Number(req.query.limit  ?? 100), 500);
  const offset = Number(req.query.offset ?? 0);
  const adminId = req.query.admin_id ? Number(req.query.admin_id) : undefined;
  const [total, logs] = await Promise.all([
    prisma.adminActivityLog.count({ where: adminId ? { admin_id: adminId } : {} }),
    prisma.adminActivityLog.findMany({
      where:   adminId ? { admin_id: adminId } : {},
      orderBy: { created_at: 'desc' },
      skip:    offset,
      take:    limit,
    }),
  ]);
  res.json({ success: true, data: logs, total });
});

// ─── Security / auth logs ──────────────────────────────────────────────────────

router.get('/logs/auth', requireAdmin, async (req: Request, res: Response) => {
  if (!isSuperAdmin(req) && !(req.admin as any).permissions?.can_view_logs) {
    res.status(403).json({ success: false, error: 'Access denied' }); return;
  }
  const limit   = Math.min(Number(req.query.limit  ?? 100), 500);
  const offset  = Number(req.query.offset ?? 0);
  const onlyFailed = req.query.failed === 'true';
  const [total, logs] = await Promise.all([
    prisma.adminAuthLog.count({ where: onlyFailed ? { success: false } : {} }),
    prisma.adminAuthLog.findMany({
      where:   onlyFailed ? { success: false } : {},
      orderBy: { created_at: 'desc' },
      skip:    offset,
      take:    limit,
    }),
  ]);
  res.json({ success: true, data: logs, total });
});

// ─── Permission list (meta) ───────────────────────────────────────────────────

router.get('/permissions', requireAdmin, (_req: Request, res: Response) => {
  res.json({ success: true, data: ALL_PERMISSIONS });
});

export default router;
