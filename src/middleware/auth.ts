import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'fallback_dev_secret_change_in_production';

export interface AdminPayload {
  id: number;
  username: string;
  role: string;
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
