/**
 * Public update-check endpoints — no auth required.
 * Called by the POS Electron app to discover new versions.
 */
import { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import prisma from '../db';
import { RELEASES_DIR } from '../lib/releases';

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
 * SHA-256 + byte size of an installer hosted on this server, so the POS can refuse to install a
 * truncated or altered download. Computed from the file on disk (no DB column needed) and cached
 * until the file changes. Returns null for installers hosted elsewhere.
 */
const hashCache = new Map<string, { key: string; sha256: string; size: number }>();
async function localInstallerHash(downloadUrl: string): Promise<{ sha256: string; size: number } | null> {
  const m = String(downloadUrl || '').match(/\/api\/updates\/download\/([^/?#]+)/);
  if (!m) return null;
  const full = path.resolve(RELEASES_DIR, path.basename(decodeURIComponent(m[1])));
  if (!full.startsWith(path.resolve(RELEASES_DIR)) || !fs.existsSync(full)) return null;
  const st = fs.statSync(full);
  const key = `${st.size}:${st.mtimeMs}`;
  const hit = hashCache.get(full);
  if (hit && hit.key === key) return { sha256: hit.sha256, size: hit.size };
  const sha256 = await new Promise<string>((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(full).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
  hashCache.set(full, { key, sha256, size: st.size });
  return { sha256, size: st.size };
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
  let integrity: { sha256: string; size: number } | null = null;
  if (update_available) { try { integrity = await localInstallerHash(latest.download_url); } catch { integrity = null; } }

  res.json({
    success: true,
    update_available,
    current: currentVersion,
    latest: {
      version:      latest.version,
      channel:      latest.channel,
      changelog:    latest.changelog,
      download_url: latest.download_url,
      file_size:    integrity?.size ?? latest.file_size,
      sha256:       integrity?.sha256 ?? null,
      is_mandatory: latest.is_mandatory,
      published_at: latest.created_at,
    },
  });
});

/**
 * GET /api/updates/download/:file
 *
 * Streams an uploaded installer to the POS app. Public (no auth) so the
 * updater can fetch it directly. The filename is sanitised to block path
 * traversal — only files inside RELEASES_DIR can be served.
 */
router.get('/download/:file', (req: Request, res: Response) => {
  const name = path.basename(String(req.params.file || ''));
  const full = path.resolve(RELEASES_DIR, name);

  if (!full.startsWith(path.resolve(RELEASES_DIR)) || !fs.existsSync(full)) {
    res.status(404).json({ success: false, error: 'Installer not found' });
    return;
  }
  // res.download sets Content-Disposition: attachment + Content-Length.
  res.download(full, name);
});

export default router;
