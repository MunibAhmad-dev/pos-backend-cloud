import { Request, Response, NextFunction } from 'express';
import prisma from '../../db';

declare global {
  namespace Express {
    interface Request {
      mfgInstance?: Awaited<ReturnType<typeof prisma.manufacturingInstance.findUnique>>;
    }
  }
}

/**
 * Authenticates a Factory ERP (manufacturing) install via its api_key,
 * issued once at /register and stored locally by the Electron app.
 * Mirrors requireInstance for the POS but kept separate since these are
 * different apps/tables.
 */
export async function requireManufacturingInstance(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ success: false, error: 'Missing Authorization header' });
    return;
  }
  const apiKey = authHeader.slice(7).trim();
  const instance = await prisma.manufacturingInstance.findUnique({ where: { api_key: apiKey } });
  if (!instance) {
    res.status(401).json({ success: false, error: 'Invalid API key' });
    return;
  }
  if (instance.approval_status === 'blocked') {
    res.status(403).json({ success: false, error: 'blocked', message: 'This installation has been blocked. Contact support.' });
    return;
  }
  req.mfgInstance = instance;
  next();
}
