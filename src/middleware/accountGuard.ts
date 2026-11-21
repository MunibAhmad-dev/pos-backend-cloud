/**
 * Abuse protection for account creation and sign-in.
 *
 *  - New accounts per IP are capped (per hour and per day). Only real creations count —
 *    signing in to an existing account, or a branch registration with a valid code, does not.
 *  - An IP that keeps trying after hitting the cap is blocked from every account endpoint
 *    for BLOCK_HOURS. Blocks survive restarts (saved to data/ip-blocks.json).
 *  - Wrong passwords: too many for one mobile pauses that mobile; an IP failing across many
 *    mobiles (password spraying) gets blocked.
 *
 * In-memory counters are per process — fine for the single PM2 instance this API runs as.
 * Tune with env: ACCOUNT_CREATE_PER_HOUR, ACCOUNT_CREATE_PER_DAY, IP_BLOCK_HOURS,
 * TRUSTED_IPS (comma-separated, never limited — e.g. the OsaTech office).
 */
import fs from 'fs';
import path from 'path';
import { Request, Response, NextFunction } from 'express';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const num = (v: string | undefined, d: number) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };

const CREATE_PER_HOUR = num(process.env.ACCOUNT_CREATE_PER_HOUR, 3);
const CREATE_PER_DAY = num(process.env.ACCOUNT_CREATE_PER_DAY, 10);
const BLOCK_MS = num(process.env.IP_BLOCK_HOURS, 24) * HOUR;
const OVER_LIMIT_STRIKES = 5;          // refused creations (after the cap) before the IP is blocked
const FAILS_PER_MOBILE = 8;            // wrong passwords for one mobile within 15 min → pause that mobile
const FAIL_WINDOW = 15 * 60 * 1000;
const FAILS_PER_IP_BLOCK = 40;         // wrong passwords from one IP within an hour → block the IP
const TRUSTED = new Set((process.env.TRUSTED_IPS || '').split(',').map(s => s.trim()).filter(Boolean));

const creations = new Map<string, number[]>();    // ip → timestamps of accounts created
const strikes = new Map<string, number[]>();      // ip → timestamps of refused creations
const ipFails = new Map<string, number[]>();      // ip → timestamps of failed sign-ins
const mobileFails = new Map<string, number[]>();  // mobile → timestamps of failed sign-ins

const BLOCK_FILE = path.resolve(__dirname, '..', '..', 'data', 'ip-blocks.json');
type Block = { until: number; reason: string; at: number };
let blocks: Record<string, Block> = {};
try { blocks = JSON.parse(fs.readFileSync(BLOCK_FILE, 'utf8')); } catch { blocks = {}; }
const saveBlocks = () => {
  try {
    fs.mkdirSync(path.dirname(BLOCK_FILE), { recursive: true });
    fs.writeFileSync(BLOCK_FILE, JSON.stringify(blocks, null, 2));
  } catch (e: any) { console.warn('[accountGuard] could not save ip blocks:', e?.message); }
};

const recent = (map: Map<string, number[]>, key: string, windowMs: number) => {
  const now = Date.now();
  const list = (map.get(key) || []).filter(t => now - t < windowMs);
  map.set(key, list);
  return list;
};
const push = (map: Map<string, number[]>, key: string) => { const l = map.get(key) || []; l.push(Date.now()); map.set(key, l); };

export function clientIp(req: Request): string {
  return String(req.ip || req.socket?.remoteAddress || 'unknown').replace(/^::ffff:/, '');
}

function blockIp(ip: string, reason: string) {
  if (TRUSTED.has(ip)) return;
  blocks[ip] = { until: Date.now() + BLOCK_MS, reason, at: Date.now() };
  saveBlocks();
  console.warn(`[accountGuard] blocked ${ip} for ${Math.round(BLOCK_MS / HOUR)}h — ${reason}`);
}

function activeBlock(ip: string): Block | null {
  const b = blocks[ip];
  if (!b) return null;
  if (b.until <= Date.now()) { delete blocks[ip]; saveBlocks(); return null; }
  return b;
}

const tooMany = (res: Response, error: string, retryAfterMs: number) => {
  res.setHeader('Retry-After', String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
  res.status(429).json({ success: false, error, code: 'RATE_LIMITED' });
};

/** Middleware: refuses every request from a blocked IP. Put it on all account endpoints. */
export function rejectBlockedIp(req: Request, res: Response, next: NextFunction) {
  const ip = clientIp(req);
  if (TRUSTED.has(ip)) return next();
  const b = activeBlock(ip);
  if (b) {
    const hours = Math.ceil((b.until - Date.now()) / HOUR);
    return tooMany(res, `Too many attempts from your network. Try again in about ${hours} hour${hours === 1 ? '' : 's'}, or contact OsaTech support.`, b.until - Date.now());
  }
  next();
}

/**
 * Call right before creating a new account. Returns true if allowed; otherwise it has
 * already sent the 429 (and may have blocked the IP) and the caller must stop.
 */
export function allowAccountCreation(req: Request, res: Response): boolean {
  const ip = clientIp(req);
  if (TRUSTED.has(ip)) return true;
  const lastHour = recent(creations, ip, HOUR);
  const lastDay = recent(creations, ip, DAY);
  if (lastHour.length < CREATE_PER_HOUR && lastDay.length < CREATE_PER_DAY) return true;

  push(strikes, ip);
  if (recent(strikes, ip, DAY).length >= OVER_LIMIT_STRIKES) {
    blockIp(ip, `kept creating accounts after the limit (${lastDay.length} created in 24h)`);
  }
  const retry = lastHour.length >= CREATE_PER_HOUR ? HOUR - (Date.now() - lastHour[0]) : DAY - (Date.now() - lastDay[0]);
  tooMany(res, 'Too many new accounts from your network. Please try again later, or contact OsaTech support if you are setting up several shops.', retry);
  return false;
}

/** Call after an account was actually created. */
export function noteAccountCreated(req: Request) {
  push(creations, clientIp(req));
}

/** Call before checking a password. Returns false (429 sent) if this mobile is paused. */
export function allowSignInAttempt(req: Request, res: Response, mobile: string): boolean {
  const ip = clientIp(req);
  if (TRUSTED.has(ip)) return true;
  const fails = recent(mobileFails, mobile, FAIL_WINDOW);
  if (fails.length >= FAILS_PER_MOBILE) {
    tooMany(res, 'Too many wrong passwords for this number. Please wait 15 minutes and try again.', FAIL_WINDOW - (Date.now() - fails[0]));
    return false;
  }
  return true;
}

/** Call when a password check fails. */
export function noteFailedSignIn(req: Request, mobile: string) {
  const ip = clientIp(req);
  if (TRUSTED.has(ip)) return;
  push(mobileFails, mobile);
  push(ipFails, ip);
  if (recent(ipFails, ip, HOUR).length >= FAILS_PER_IP_BLOCK) blockIp(ip, 'too many failed sign-ins across accounts');
}

/** Call after a successful sign-in — clears that mobile's failure count. */
export function noteSuccessfulSignIn(mobile: string) {
  mobileFails.delete(mobile);
}

/** Basic sanity check on a new account's mobile number (digits, 10–15 long after stripping + - spaces). */
export function validMobile(mobile: string): boolean {
  const digits = String(mobile || '').replace(/[\s\-+()]/g, '');
  return /^\d{10,15}$/.test(digits);
}

/** For the admin panel: current blocks. */
export function listIpBlocks() {
  const now = Date.now();
  return Object.entries(blocks).filter(([, b]) => b.until > now).map(([ip, b]) => ({ ip, ...b }));
}

export function unblockIp(ip: string) {
  delete blocks[ip];
  creations.delete(ip); strikes.delete(ip); ipFails.delete(ip);
  saveBlocks();
}

// Keep memory bounded on a long-running process.
setInterval(() => {
  for (const m of [creations, strikes, ipFails]) for (const k of [...m.keys()]) if (!recent(m, k, DAY).length) m.delete(k);
  for (const k of [...mobileFails.keys()]) if (!recent(mobileFails, k, FAIL_WINDOW).length) mobileFails.delete(k);
}, HOUR).unref();
