import { Request, Response, NextFunction } from 'express';
import prisma from '../db';

/**
 * Authenticates POS instances via their API key.
 * Reads `Authorization: Bearer <api_key>`, looks up the instance in the DB,
 * and attaches `req.instance` for downstream handlers.
 *
 * Returns 403 (not 401) when the instance is blocked so the POS can distinguish
 * "wrong key" from "account blocked" and show an appropriate message.
 */
export async function requireInstance(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ success: false, error: 'Missing API key' });
    return;
  }

  const apiKey = authHeader.slice(7).trim();

  const instance = await prisma.instance.findUnique({ where: { api_key: apiKey } });

  if (!instance) {
    res.status(401).json({ success: false, error: 'Invalid API key' });
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
