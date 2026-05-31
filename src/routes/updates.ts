/**
 * Public update-check endpoints — no auth required.
 * Called by the POS Electron app to discover new versions.
 */
import { Router, Request, Response } from 'express';
import prisma from '../db';

const router = Router();

// ── Semver comparison helper ──────────────────────────────────────────────────
function isNewer(current: string, candidate: string): boolean {
  const parse = (v: string) => v.replace(/^v/, '').split('.').map(Number);
  const c = parse(current);
  const n = parse(candidate);
  for (let i = 0; i < 3; i++) {
    if ((n[i] ?? 0) > (c[i] ?? 0)) return true;
    if ((n[i] ?? 0) < (c[i] ?? 0)) return false;
  }
  return false;
}

/**
 * GET /api/updates/latest?channel=stable&version=1.0.0
 *
 * Returns the latest published release for a channel.
 * If `version` param is provided, the response includes `update_available`
 * so the POS can decide whether to prompt the user.
 */
router.get('/latest', async (req: Request, res: Response) => {
  const channel = String(req.query.channel || 'stable');
  const currentVersion = String(req.query.version || '0.0.0');

  const latest = await prisma.appRelease.findFirst({
    where: { channel, published: true },
    orderBy: { created_at: 'desc' },
  });

  if (!latest) {
    res.json({ success: true, update_available: false, current: currentVersion });
    return;
  }

  const update_available = isNewer(currentVersion, latest.version);

  res.json({
    success: true,
    update_available,
    current: currentVersion,
    latest: {
      version:      latest.version,
      channel:      latest.channel,
      changelog:    latest.changelog,
      download_url: latest.download_url,
      file_size:    latest.file_size,
      is_mandatory: latest.is_mandatory,
      published_at: latest.created_at,
    },
  });
});

export default router;
