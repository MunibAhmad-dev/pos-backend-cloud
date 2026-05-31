import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'fallback_dev_secret_change_in_production';

export interface AdminPayload {
  id: number;
  username: string;
  role: string;
}

// Scoped JWT issued to a POS instance for mobile app access.
// Separate secret so mobile tokens can be invalidated independently.
export interface MobilePayload {
  instance_id: string;
  store_name:  string;
  owner_mobile: string;
  scope: 'mobile';   // distinguishes from admin tokens
}

const MOBILE_SECRET = process.env.MOBILE_JWT_SECRET
  || process.env.JWT_SECRET
  || 'fallback_mobile_secret';

export function signMobileToken(payload: MobilePayload): string {
  return jwt.sign(payload, MOBILE_SECRET, { expiresIn: '90d' });
}

export function verifyMobileToken(token: string): MobilePayload {
  return jwt.verify(token, MOBILE_SECRET) as MobilePayload;
}

/** Middleware: accepts EITHER an admin JWT OR a mobile-scoped JWT. */
export function requireMobileOrAdmin(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ success: false, error: 'Missing Authorization header' });
    return;
  }
  const token = authHeader.slice(7);
  try {
    // Try mobile token first
    const payload = jwt.verify(token, MOBILE_SECRET) as any;
    if (payload.scope === 'mobile') {
      (req as any).mobileInstance = payload as MobilePayload;
      next();
      return;
    }
  } catch { /* not a mobile token — try admin */ }
  try {
    const payload = jwt.verify(token, JWT_SECRET) as AdminPayload;
    req.admin = payload;
    next();
  } catch {
    res.status(401).json({ success: false, error: 'Token expired or invalid' });
  }
}

/**
 * Protects admin routes. Reads `Authorization: Bearer <token>`,
 * verifies the JWT, and attaches `req.admin` for downstream handlers.
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ success: false, error: 'Missing or invalid Authorization header' });
    return;
  }

  const token = authHeader.slice(7);
  try {
    const payload = jwt.verify(token, JWT_SECRET) as AdminPayload;
    req.admin = payload;
    next();
  } catch (err) {
    res.status(401).json({ success: false, error: 'Token expired or invalid' });
  }
}

export function signAdminToken(payload: AdminPayload): string {
  const expiresIn = (process.env.JWT_EXPIRES_IN || '7d') as string;
  return jwt.sign(payload, JWT_SECRET, { expiresIn } as jwt.SignOptions);
}
