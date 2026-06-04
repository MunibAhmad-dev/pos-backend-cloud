import { Request, Response, NextFunction } from 'express';
import prisma from '../db';
import { verifyMobileToken } from './auth';

/**
 * Authenticates POS instances via:
 *   1. A mobile JWT (scope: 'mobile') — issued to store owners for the mobile app
 *   2. A raw api_key — used by the POS desktop app
 *
 * Attaches `req.instance` for downstream handlers.
 */
export async function requireInstance(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ success: false, error: 'Missing Authorization header' });
    return;
  }

  const token = authHeader.slice(7).trim();

  // ── Try mobile JWT first ──────────────────────────────────────────────────
  // Mobile tokens are JWTs (3 dot-separated parts) with scope: 'mobile'
  let instance = null;
  if (token.split('.').length === 3) {
    try {
      const payload = verifyMobileToken(token);
      if (payload.scope === 'mobile' && payload.instance_id) {
        instance = await prisma.instance.findUnique({ where: { instance_id: payload.instance_id } });
      }
    } catch {
      // Not a valid mobile JWT — fall through to api_key lookup
    }
  }

  // ── Fall back to raw api_key lookup ───────────────────────────────────────
  if (!instance) {
    instance = await prisma.instance.findUnique({ where: { api_key: token } });
  }

  if (!instance) {
    res.status(401).json({ success: false, error: 'Invalid API key or token' });
    return;
  }

  if (instance.approval_status === 'blocked') {
    // Include license_revoked so the POS can distinguish hard (license) from
    // soft (cloud-services) blocks and fire the correct event (pos-blocked vs
    // pos-cloud-blocked).
    const isLicenseRevoke = (instance.license_revoked ?? 0) === 1;
    res.status(403).json({
      success:         false,
      error:           isLicenseRevoke ? 'license_revoked' : 'blocked',
      license_revoked: instance.license_revoked ?? 0,
      message:         instance.block_reason
                         || (isLicenseRevoke
                           ? 'Your license has been revoked. Contact OsaTech.'
                           : 'This POS instance has been blocked. Contact support.'),
      block_reason:    instance.block_reason || null,
    });
    return;
  }

  req.instance = instance as any;
  next();
}
