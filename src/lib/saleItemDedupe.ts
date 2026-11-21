/**
 * Duplicated sale lines in the cloud — same rules as the desktop's dedupeSaleItems() (main.ts).
 *
 * An old desktop bug (edit-sale-items) stored a sale's items again under new ids without deleting
 * the old ones, and devices uploaded every copy. Revenue uses the sale total (counted once) while
 * COGS adds up every line, so gross profit went wrong — on the PCs and in the admin dashboard.
 *
 * A sale is only cleaned when:
 *   - it is live (not cancelled / returned),
 *   - its lines add up to more than its subtotal,
 *   - one run of lines (newest-first, else oldest-first) adds up exactly to the subtotal (±1), and
 *   - every extra line is a copy of a product in that run (same product id or same name) with no
 *     return pointing at it.
 * Anything else is left alone. Cleaning appends ordinary `sale_item` delete events, so every PC
 * of the shop removes the lines on its next pull and exports/web POS stop showing them.
 */
import prisma from '../db';

const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const isLive = (s: any) => !['cancelled', 'returned'].includes(String(s?.status ?? '').toLowerCase());

export interface SaleDuplicate {
  sale_id: string;
  date: string | null;
  subtotal: number;
  lines_total: number;
  remove_ids: string[];
  extra_revenue: number;
  extra_cogs: number;
}

/** Pure check over reconstructed state — no database access. */
export function findDuplicateSaleItems(sales: any[], saleItems: any[], returnItems: any[]): { duplicates: SaleDuplicate[]; skipped: number } {
  const referenced = new Set(returnItems.map(r => String(r?.sale_item_id ?? '')).filter(Boolean));
  const bySale = new Map<string, any[]>();
  for (const it of saleItems) {
    const k = String(it?.sale_id ?? '');
    if (!k) continue;
    if (!bySale.has(k)) bySale.set(k, []);
    bySale.get(k)!.push(it);
  }
  const duplicates: SaleDuplicate[] = [];
  let skipped = 0;
  for (const s of sales) {
    if (!isLive(s)) continue;
    const rows = bySale.get(String(s.id));
    if (!rows?.length) continue;
    const lineSum = rows.reduce((a, r) => a + num(r.quantity) * num(r.price), 0);
    const target = num(s.subtotal) > 0 ? num(s.subtotal) : num(s.total) + num(s.discount) - num(s.tax);
    if (Math.abs(lineSum - target) <= 1 || lineSum < target) continue;
    // Newest first — POS ids grow over time; ties fall back to string order.
    const sorted = [...rows].sort((a, b) => (num(b.id) - num(a.id)) || String(b.id).localeCompare(String(a.id)));
    const prefix = (list: any[]): any[] | null => {
      let sum = 0;
      for (let i = 0; i < list.length; i++) {
        sum += num(list[i].quantity) * num(list[i].price);
        if (Math.abs(sum - target) <= 1) return list.slice(0, i + 1);
        if (sum > target + 1) return null;
      }
      return null;
    };
    const kept = prefix(sorted) ?? prefix([...sorted].reverse());
    if (!kept) { skipped++; continue; }
    const keptIds = new Set(kept.map(r => String(r.id)));
    const keptPids = new Set(kept.map(r => (r.product_id == null ? '' : String(r.product_id))).filter(Boolean));
    const keptNames = new Set(kept.map(r => String(r.product_name ?? '').trim().toLowerCase()).filter(Boolean));
    const extra = rows.filter(r => !keptIds.has(String(r.id)));
    const isCopy = (r: any) => (r.product_id != null && keptPids.has(String(r.product_id)))
      || keptNames.has(String(r.product_name ?? '').trim().toLowerCase());
    if (!extra.length || extra.some(r => !isCopy(r) || referenced.has(String(r.id)))) { skipped++; continue; }
    duplicates.push({
      sale_id: String(s.id), date: s.date_created ?? null, subtotal: target, lines_total: Math.round(lineSum),
      remove_ids: extra.map(r => String(r.id)),
      extra_revenue: Math.round(extra.reduce((a, r) => a + num(r.quantity) * num(r.price), 0)),
      extra_cogs: Math.round(extra.reduce((a, r) => a + num(r.quantity) * Math.min(num(r.purchase_price), 1_000_000), 0)),
    });
  }
  return { duplicates, skipped };
}

/** Rebuild the current sales / sale lines / return lines of one shop from its event log. */
async function loadState(instanceId: string) {
  const maps: Record<string, Map<string, any>> = { sale: new Map(), sale_item: new Map(), sale_return_item: new Map() };
  let cursor = 0;
  for (;;) {
    const batch = await prisma.syncEvent.findMany({
      where: { instance_id: instanceId, entity_type: { in: Object.keys(maps) }, id: { gt: cursor } },
      orderBy: { id: 'asc' }, take: 5000,
      select: { id: true, entity_type: true, operation: true, payload: true },
    });
    if (!batch.length) break;
    for (const ev of batch) {
      let p: any;
      try { p = JSON.parse(ev.payload); } catch { continue; }
      if (!p || p.id == null) continue;
      const m = maps[ev.entity_type];
      if (ev.operation === 'delete') m.delete(String(p.id));
      else m.set(String(p.id), { ...(m.get(String(p.id)) || {}), ...p });
    }
    cursor = batch[batch.length - 1].id;
    if (batch.length < 5000) break;
  }
  return { sales: [...maps.sale.values()], saleItems: [...maps.sale_item.values()], returnItems: [...maps.sale_return_item.values()] };
}

export interface ShopDuplicateReport {
  instance_id: string;
  store_name: string;
  sales_affected: number;
  lines_to_remove: number;
  extra_revenue: number;
  extra_cogs: number;
  skipped: number;
  samples: SaleDuplicate[];
}

export async function scanShop(instanceId: string, storeName = ''): Promise<ShopDuplicateReport & { all: SaleDuplicate[] }> {
  const st = await loadState(instanceId);
  const { duplicates, skipped } = findDuplicateSaleItems(st.sales, st.saleItems, st.returnItems);
  return {
    instance_id: instanceId, store_name: storeName,
    sales_affected: duplicates.length,
    lines_to_remove: duplicates.reduce((a, d) => a + d.remove_ids.length, 0),
    extra_revenue: duplicates.reduce((a, d) => a + d.extra_revenue, 0),
    extra_cogs: duplicates.reduce((a, d) => a + d.extra_cogs, 0),
    skipped, samples: duplicates.slice(0, 5), all: duplicates,
  };
}

/** Append one delete event per duplicated line. Returns how many were written. */
export async function fixShop(instanceId: string): Promise<{ removed: number; sales: number }> {
  const scan = await scanShop(instanceId);
  const ids = scan.all.flatMap(d => d.remove_ids);
  if (!ids.length) return { removed: 0, sales: 0 };
  for (let i = 0; i < ids.length; i += 1000) {
    await prisma.syncEvent.createMany({
      data: ids.slice(i, i + 1000).map(id => ({
        instance_id: instanceId, entity_type: 'sale_item', operation: 'delete',
        payload: JSON.stringify({ id: Number.isFinite(Number(id)) ? Number(id) : id, reason: 'duplicate_sale_item_cleanup' }),
      })),
    });
  }
  return { removed: ids.length, sales: scan.all.length };
}

/**
 * Optional background cleanup (AUTO_DEDUPE_SALE_ITEMS=true): shops on old desktop versions still
 * create duplicates when they edit a sale. Every few hours, clean only the shops that uploaded sale
 * lines since the last run. Same strict rules as the admin button.
 */
export function startDuplicateSaleItemJob(everyHours = 6) {
  if (String(process.env.AUTO_DEDUPE_SALE_ITEMS || '').toLowerCase() !== 'true') return;
  let since = new Date(Date.now() - everyHours * 3600_000);
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    const started = new Date();
    try {
      const recent = await prisma.syncEvent.findMany({
        where: { entity_type: 'sale_item', received_at: { gte: since } },
        distinct: ['instance_id'], select: { instance_id: true },
      });
      let removed = 0;
      for (const r of recent) removed += (await fixShop(r.instance_id)).removed;
      if (removed) console.log(`[dedupe] removed ${removed} duplicated sale line(s) across ${recent.length} shop(s)`);
      since = started;
    } catch (e: any) {
      console.warn('[dedupe] background cleanup failed:', e?.message);
    } finally { running = false; }
  };
  setTimeout(run, 60_000);
  setInterval(run, everyHours * 3600_000);
}
