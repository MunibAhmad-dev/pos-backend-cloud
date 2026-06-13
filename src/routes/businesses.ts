import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import bcrypt from 'bcryptjs';
import prisma from '../db';

const router = Router();

/**
 * POST /api/register-business   (PUBLIC — no auth)
 *
 * Called from the POS Setup page when the user chooses "Online Verify".
 * Creates an instance with approval_status = 'pending' and returns the api_key.
 * Idempotent — returns existing api_key if already registered (same mobile + branch).
 */
router.post('/register-business', async (req: Request, res: Response) => {
  const { businessName, ownerName, mobile, email, address, fingerprint, branchName, password, mode } =
    req.body as Record<string, string>;

  // mode: 'register' (new account) | 'signin' (restore existing) — defaults to 'signin' for
  // backwards compat with old POS clients that don't send the field
  const isRegister = mode === 'register';

  if (!mobile) {
    res.status(400).json({ success: false, error: 'mobile is required' });
    return;
  }

  const branch = (branchName || 'Main Branch').trim();

  try {
    // Look up by mobile + branch
    const existing = await prisma.instance.findFirst({
      where: { owner_mobile: mobile.trim(), branch_name: branch },
    });

    if (existing) {
      // ── Register mode: block if account already has a password set ──────────
      // The customer should use Sign In to restore access, not create a new account.
      if (isRegister && existing.password_hash) {
        res.status(409).json({
          success: false,
          error: 'Account already exists. Please use Sign In to restore access.',
        });
        return;
      }

      // ── Sign-in / idempotent re-registration ─────────────────────────────────
      if (existing.password_hash && password) {
        const ok = await bcrypt.compare(password, existing.password_hash);
        if (!ok) {
          res.status(401).json({ success: false, error: 'Incorrect password' });
          return;
        }
      } else if (existing.password_hash && !password) {
        res.status(401).json({ success: false, error: 'Password required for this account' });
        return;
      }

      const updateData: Record<string, any> = {};
      if (fingerprint && fingerprint !== existing.device_fingerprint)
        updateData.device_fingerprint = fingerprint.trim();
      if (!existing.password_hash && password) {
        updateData.password_hash  = await bcrypt.hash(password, 10);
        updateData.password_plain = password.trim();
      }

      if (Object.keys(updateData).length)
        await prisma.instance.update({ where: { instance_id: existing.instance_id }, data: updateData });

      res.json({
        success: true,
        instance_id:     existing.instance_id,
        api_key:         existing.api_key,
        approval_status: existing.approval_status,
        message: 'Already registered',
      });
      return;
    }

    // New registration
    const instance_id    = uuidv4();
    const api_key        = uuidv4();
    const password_hash  = password ? await bcrypt.hash(password, 10) : '';
    const password_plain = password ? password.trim() : '';

    await prisma.instance.create({
      data: {
        instance_id,
        api_key,
        owner_mobile:       mobile.trim(),
        business_name:      businessName   || '',
        owner_name:         ownerName      || '',
        owner_email:        email          || '',
        store_address:      address        || '',
        store_name:         businessName   || '',
        device_fingerprint: fingerprint    || '',
        branch_name:        branch,
        approval_status:    'pending',
        password_hash,
        password_plain,
      },
    });

    res.status(201).json({
      success: true,
      instance_id,
      api_key,
      approval_status: 'pending',
      message: 'Registration received. Awaiting admin approval.',
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/approval-status?instance_id=xxx  (PUBLIC — no auth)
 *
 * Polled by the POS Setup screen every 5 seconds.
 */
router.get('/approval-status', async (req: Request, res: Response) => {
  const instanceId = ((req.query.instance_id as string) || '').trim();
  const mobile     = ((req.query.mobile      as string) || '').trim();

  if (!instanceId && !mobile) {
    res.status(400).json({ success: false, error: 'instance_id or mobile is required' });
    return;
  }

  try {
    let row: { approval_status: string; license_key: string; block_reason: string } | null = null;

    if (instanceId) {
      row = await prisma.instance.findUnique({
        where: { instance_id: instanceId },
        select: { approval_status: true, license_key: true, block_reason: true },
      });
    } else {
      row = await prisma.instance.findFirst({
        where: { owner_mobile: mobile },
        orderBy: { created_at: 'desc' },
        select: { approval_status: true, license_key: true, block_reason: true },
      });
    }

    if (!row) {
      res.json({ success: true, status: 'not_registered' });
      return;
    }

    res.json({
      success: true,
      status:      row.approval_status,
      licenseKey:  row.license_key  || undefined,
      blockReason: row.block_reason || undefined,
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
