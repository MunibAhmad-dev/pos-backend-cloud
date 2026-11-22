/**
 * Sale lines lost to the desktop's sync-time duplicate clean-up (2.55 – 2.57).
 *
 * When a bill edited on one PC reached another PC in pieces (new lines first, new total later), the
 * other PC's clean-up compared the lines with the OLD total, decided the NEW lines were duplicates,
 * deleted them and uploaded the deletes. The editing PC's own deletes of the old lines then arrived
 * as well, so the bill was left with fewer lines (often none) than its total: revenue still counted,
 * its purchase cost no longer did, and profit went far too high.
 *
 * Nothing is lost in the cloud — every line's create event is still in sync_events. For each live
 * sale whose remaining lines add up to LESS than its subtotal, this finds the deleted lines of that
 * sale which exactly fill the gap, newest first (by when the cloud first received them, which is
 * the order of edits whatever device made them). Only an exact match (±1) is restored; anything
 * else is listed for a manual look and left alone.
 *
 * Restoring appends ordinary `sale_item` create events carrying `restored_lost_line: 1` with the
 * line's last full payload, so every PC re-adds the line on its next pull (desktop 2.58+ lets this
 * flag past its local "I deleted this" tombstone).
 */
import prisma from '../db';

const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const isLive = (s: any) => !['cancelled', 'returned'].includes(String(s?.status ?? '').toLowerCase());

export interface LostSale {
  sale_id: string;
  date: string | null;
  subtotal: number;
  lines_total: number;
  missing: number;
  restore: any[];          // payloads to re-create (empty when no exact match)
  restore_revenue: number;
  restore_cogs: number;
  exact: boolean;
}

type Ev = { id: number; entity_type: string; operation: string; payload: string };

const targetOf = (s: any) => (num(s?.subtotal) > 0 ? num(s.subtotal) : num(s?.total) + num(s?.discount) - num(s?.tax));

function newState() {
  return {
    sales: new Map<string, any>(),
    items: new Map<string, any>(),
    deleted: new Map<string, { payload: any; firstSeen: number }>(),
    firstSeen: new Map<string, number>(),
    bySale: new Map<string, Set<string>>(),                  // sale id → ids of its current lines
    lastComplete: new Map<string, Map<string, any>>(),       // sale id → last set of lines that added up to the bill
  };
}

/** Replay sale / sale_item events into current sales, current lines, deleted lines, and — for every
 *  sale — the last moment its lines added up exactly to its subtotal (the last complete version). */
export function replayEvents(events: Ev[], st = newState()) {
  const link = (saleId: string, k: string) => { if (!st.bySale.has(saleId)) st.bySale.set(saleId, new Set()); st.bySale.get(saleId)!.add(k); };
  const unlink = (saleId: string, k: string) => { st.bySale.get(saleId)?.delete(k); };
  const snapshot = (saleId: string) => {
    const sale = st.sales.get(saleId); const ids = st.bySale.get(saleId);
    if (!sale || !ids?.size) return;
    let sum = 0; for (const k of ids) { const it = st.items.get(k); sum += num(it?.quantity) * num(it?.price); }
    const target = targetOf(sale);
    if (target > 0 && Math.abs(sum - target) <= 1) st.lastComplete.set(saleId, new Map([...ids].map(k => [k, { ...st.items.get(k) }])));
  };
  for (const ev of events) {
    let p: any;
    try { p = JSON.parse(ev.payload); } catch { continue; }
    if (!p || p.id == null) continue;
    const k = String(p.id);
    if (ev.entity_type === 'sale') {
      if (ev.operation === 'delete') st.sales.delete(k); else st.sales.set(k, { ...(st.sales.get(k) || {}), ...p });
      snapshot(k);
      continue;
    }
    if (ev.entity_type !== 'sale_item') continue;
    const prev = st.items.get(k);
    const prevSale = prev?.sale_id != null ? String(prev.sale_id) : null;
    if (ev.operation === 'delete') {
      if (prev) st.deleted.set(k, { payload: prev, firstSeen: st.firstSeen.get(k) ?? ev.id });
      st.items.delete(k);
      if (prevSale) { unlink(prevSale, k); snapshot(prevSale); }
    } else {
      if (!st.firstSeen.has(k)) st.firstSeen.set(k, ev.id);
      const next = { ...(prev || st.deleted.get(k)?.payload || {}), ...p };
      st.items.set(k, next);
      st.deleted.delete(k);
      const nowSale = next.sale_id != null ? String(next.sale_id) : null;
      if (prevSale && prevSale !== nowSale) { unlink(prevSale, k); snapshot(prevSale); }
      if (nowSale) { link(nowSale, k); snapshot(nowSale); }
    }
  }
  return st;
}

export async function loadHistory(instanceId: string) {
  let st: ReturnType<typeof replayEvents> | undefined;
  let cursor = 0;
  for (;;) {
    const batch = await prisma.syncEvent.findMany({
      where: { instance_id: instanceId, entity_type: { in: ['sale', 'sale_item'] }, id: { gt: cursor } },
      orderBy: { id: 'asc' }, take: 5000,
      select: { id: true, entity_type: true, operation: true, payload: true },
    });
    if (!batch.length) break;
    st = replayEvents(batch, st);
    cursor = batch[batch.length - 1].id;
    if (batch.length < 5000) break;
  }
  return st ?? newState();
}

/** Pure matching — exported for tests. */
export function findLostLines(sales: any[], items: any[], deleted: Array<{ payload: any; firstSeen: number }>, lastComplete?: Map<string, Map<string, any>>): LostSale[] {
  const present = new Set(items.map(it => String(it?.id)));
  const linesBySale = new Map<string, number>();
  for (const it of items) {
    const k = String(it?.sale_id ?? '');
    if (k) linesBySale.set(k, (linesBySale.get(k) || 0) + num(it.quantity) * num(it.price));
  }
  const delBySale = new Map<string, Array<{ payload: any; firstSeen: number }>>();
  for (const d of deleted) {
    const k = String(d.payload?.sale_id ?? '');
    if (!k) continue;
    if (!delBySale.has(k)) delBySale.set(k, []);
    delBySale.get(k)!.push(d);
  }
  const out: LostSale[] = [];
  for (const s of sales) {
    if (!isLive(s)) continue;
    const target = num(s.subtotal) > 0 ? num(s.subtotal) : num(s.total) + num(s.discount) - num(s.tax);
    if (target <= 0) continue;
    const have = linesBySale.get(String(s.id)) || 0;
    const gap = target - have;
    if (gap <= 1) continue;
    let pick: any[] | null = null;
    // 1. Put back the last complete version of the bill: its lines that are gone now, if they fill the gap exactly.
    const snap = lastComplete?.get(String(s.id));
    if (snap) {
      const back = [...snap.values()].filter(r => !present.has(String(r.id)));
      const backSum = back.reduce((a, r) => a + num(r.quantity) * num(r.price), 0);
      if (back.length && Math.abs(backSum - gap) <= 1) pick = back;
    }
    // 2. Otherwise the newest deleted lines of the bill that fill the gap exactly.
    const cands = pick ? [] : (delBySale.get(String(s.id)) || []).sort((a, b) => b.firstSeen - a.firstSeen);
    let sum = 0;
    for (let i = 0; i < cands.length; i++) {
      sum += num(cands[i].payload.quantity) * num(cands[i].payload.price);
      if (Math.abs(sum - gap) <= 1) { pick = cands.slice(0, i + 1).map(c => c.payload); break; }
      if (sum > gap + 1) break;
    }
    const restore = pick || [];
    out.push({
      sale_id: String(s.id), date: s.date_created ?? null, subtotal: Math.round(target), lines_total: Math.round(have),
      missing: Math.round(gap), restore, exact: !!pick,
      restore_revenue: Math.round(restore.reduce((a, r) => a + num(r.quantity) * num(r.price), 0)),
      restore_cogs: Math.round(restore.reduce((a, r) => a + num(r.quantity) * Math.min(num(r.purchase_price), 1_000_000), 0)),
    });
  }
  return out;
}

export async function scanLostLines(instanceId: string, storeName = '') {
  const h = await loadHistory(instanceId);
  const all = findLostLines([...h.sales.values()], [...h.items.values()], [...h.deleted.values()], h.lastComplete);
  const ok = all.filter(x => x.exact);
  return {
    instance_id: instanceId, store_name: storeName,
    sales_affected: all.length,
    restorable_sales: ok.length,
    lines_to_restore: ok.reduce((a, x) => a + x.restore.length, 0),
    missing_revenue: all.reduce((a, x) => a + x.missing, 0),
    restore_cogs: ok.reduce((a, x) => a + x.restore_cogs, 0),
    needs_review: all.filter(x => !x.exact).map(x => ({ sale_id: x.sale_id, date: x.date, subtotal: x.subtotal, lines_total: x.lines_total, missing: x.missing })),
    samples: ok.slice(0, 5).map(({ restore, ...r }) => ({ ...r, lines: restore.length })),
    all,
  };
}

/** Append one create event per lost line. Returns how many were written. */
export async function restoreLostLines(instanceId: string): Promise<{ restored: number; sales: number; cogs: number }> {
  const scan = await scanLostLines(instanceId);
  const ok = scan.all.filter(x => x.exact);
  const rows = ok.flatMap(x => x.restore);
  for (let i = 0; i < rows.length; i += 1000) {
    await prisma.syncEvent.createMany({
      data: rows.slice(i, i + 1000).map(p => ({
        instance_id: instanceId, entity_type: 'sale_item', operation: 'create',
        payload: JSON.stringify({ ...p, restored_lost_line: 1 }),
      })),
    });
  }
  return { restored: rows.length, sales: ok.length, cogs: scan.restore_cogs };
}

export interface SaleLineFix { creates?: any[]; updates?: any[]; deletes?: Array<string | number>; allow_mismatch?: Array<string | number> }

/**
 * A hand-checked correction for one shop's bill lines (prepared offline from the shop's own backups).
 * Preview compares every touched bill before/after against the CLOUD's current state; apply refuses
 * unless every create is missing, every update/delete exists, and every touched bill then adds up to
 * its subtotal (bills listed in allow_mismatch excepted). Creates/updates carry restored_lost_line so
 * PCs accept them past their own delete records.
 */
export async function previewOrApplyFix(instanceId: string, fix: SaleLineFix, apply: boolean) {
  const h = await loadHistory(instanceId);
  const creates = fix.creates || [], updates = fix.updates || [], deletes = (fix.deletes || []).map(String);
  const allow = new Set((fix.allow_mismatch || []).map(String));
  const problems: string[] = [];
  for (const c of creates) if (h.items.has(String(c.id))) problems.push(`create ${c.id}: line already exists in the cloud`);
  for (const u of updates) if (!h.items.has(String(u.id))) problems.push(`update ${u.id}: line not found in the cloud`);
  for (const d of deletes) if (!h.items.has(d)) problems.push(`delete ${d}: line not found in the cloud`);
  // after-state
  const after = new Map(h.items);
  for (const d of deletes) after.delete(d);
  for (const u of updates) after.set(String(u.id), { ...(after.get(String(u.id)) || {}), ...u });
  for (const c of creates) after.set(String(c.id), c);
  const touched = new Set<string>([...creates, ...updates].map(r => String(r.sale_id)).concat(deletes.map(d => String(h.items.get(d)?.sale_id ?? ''))).filter(Boolean));
  const sum = (m: Map<string, any>, sid: string) => { let v = 0, c = 0, n = 0; for (const it of m.values()) if (String(it.sale_id) === sid) { v += num(it.quantity) * num(it.price); c += num(it.quantity) * Math.min(num(it.purchase_price), 1_000_000); n++; } return { value: Math.round(v), cost: Math.round(c), lines: n }; };
  const bills = [...touched].map(sid => {
    const sale = h.sales.get(sid);
    const b = sum(h.items, sid), a = sum(after, sid), target = Math.round(targetOf(sale));
    const ok = Math.abs(a.value - target) <= 1;
    if (!sale) problems.push(`bill ${sid}: not found in the cloud`);
    else if (!ok && !allow.has(sid)) problems.push(`bill ${sid}: lines would add up to ${a.value}, bill is ${target}`);
    return { sale_id: sid, date: sale?.date_created ?? null, bill: target, before: b, after: a, adds_up: ok };
  });
  const result = { problems, bills, cost_change: bills.reduce((t, b) => t + b.after.cost - b.before.cost, 0), applied: false };
  if (!apply || problems.length) return result;
  const ev = (operation: string, payload: any) => ({ instance_id: instanceId, entity_type: 'sale_item', operation, payload: JSON.stringify(payload) });
  await prisma.syncEvent.createMany({ data: [
    ...deletes.map(d => ev('delete', { id: Number.isFinite(Number(d)) ? Number(d) : d, reason: 'sale_line_fix' })),
    ...updates.map(u => ev('update', { ...h.items.get(String(u.id)), ...u, restored_lost_line: 1 })),
    ...creates.map(c => ev('create', { ...c, restored_lost_line: 1 })),
  ] });
  return { ...result, applied: true };
}
