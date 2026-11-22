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

/** Replay sale / sale_item events into current sales, current lines and deleted lines. */
export function replayEvents(events: Ev[], st = { sales: new Map<string, any>(), items: new Map<string, any>(), deleted: new Map<string, { payload: any; firstSeen: number }>(), firstSeen: new Map<string, number>() }) {
  for (const ev of events) {
    let p: any;
    try { p = JSON.parse(ev.payload); } catch { continue; }
    if (!p || p.id == null) continue;
    const k = String(p.id);
    if (ev.entity_type === 'sale') {
      if (ev.operation === 'delete') st.sales.delete(k); else st.sales.set(k, { ...(st.sales.get(k) || {}), ...p });
      continue;
    }
    if (ev.entity_type !== 'sale_item') continue;
    if (ev.operation === 'delete') {
      const last = st.items.get(k);
      if (last) st.deleted.set(k, { payload: last, firstSeen: st.firstSeen.get(k) ?? ev.id });
      st.items.delete(k);
    } else {
      if (!st.firstSeen.has(k)) st.firstSeen.set(k, ev.id);
      st.items.set(k, { ...(st.items.get(k) || st.deleted.get(k)?.payload || {}), ...p });
      st.deleted.delete(k);
    }
  }
  return st;
}

async function loadHistory(instanceId: string) {
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
  return st ?? replayEvents([]);
}

/** Pure matching — exported for tests. */
export function findLostLines(sales: any[], items: any[], deleted: Array<{ payload: any; firstSeen: number }>): LostSale[] {
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
    const cands = (delBySale.get(String(s.id)) || []).sort((a, b) => b.firstSeen - a.firstSeen);
    let sum = 0; let pick: any[] | null = null;
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
  const all = findLostLines([...h.sales.values()], [...h.items.values()], [...h.deleted.values()]);
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
