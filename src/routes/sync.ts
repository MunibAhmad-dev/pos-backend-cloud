import { Router, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import prisma from '../db';
import { requireInstance } from '../middleware/instanceAuth';
import '../types';

const router = Router();

interface SyncItem {
  entity_type: string;
  operation: string;
  payload: Record<string, any>;
  local_id?: number;
}

/**
 * POST /api/sync   [instanceAuth]
 *
 * Batch ingest. Each item is stored as a raw event; sale items are also
 * flattened into instance_sales. Instance aggregates are updated atomically.
 */
router.post('/', requireInstance, async (req: Request, res: Response) => {
  const inst  = req.instance!;

  // Cloud-only soft block — instance can still run locally but sync is suspended
  if ((inst as any).cloud_blocked) {
    res.status(403).json({
      success: false,
      error:   'cloud_blocked',
      message: (inst as any).block_reason || 'Cloud sync has been suspended for this instance by the administrator.',
    });
    return;
  }

  const { items } = req.body as { items?: SyncItem[] };

  if (!Array.isArray(items) || items.length === 0) {
    res.status(400).json({ success: false, error: 'items array is required and must not be empty' });
    return;
  }
  if (items.length > 100) {
    res.status(400).json({ success: false, error: 'Maximum 100 items per sync batch' });
    return;
  }

  const results: Array<{ local_id?: number; success: boolean; error?: string }> = [];
  let synced = 0;
  let newSalesRevenue  = 0;
  let newSalesCount    = 0;
  let hasCustomerEvents = false;
  let hasProductEvents  = false;

  // A full resync re-sends every row a PC still has, flagged _resync. It is a snapshot, not a new
  // record: if the cloud has since deleted that row (an edited bill's old lines, a removed payment…),
  // re-sending it must NOT bring it back — that resurrected deleted bill lines on every PC (Khalid,
  // 23 Nov). Look up which of this batch's types have deletes once per batch.
  const ID_RE = `"id":"?([^",}]*)`;
  const cloudDeleted = new Map<string, number>();   // `${type}:${id}` → latest delete event id
  const resyncTypes = [...new Set(items.filter(i => i?.payload && (i.payload as any)._resync && i.operation !== 'delete').map(i => i.entity_type))];
  // Older PCs (≤2.57) don't flag their resyncs, so sale lines are always checked (see the sale_item rule below).
  if (items.some(i => i?.entity_type === 'sale_item' && i.operation !== 'delete') && !resyncTypes.includes('sale_item')) resyncTypes.push('sale_item');
  if (resyncTypes.length) {
    try {
      const rows = await prisma.$queryRaw<Array<{ entity_type: string; eid: string | null; did: number }>>(Prisma.sql`
        SELECT entity_type, substring(payload from ${ID_RE}) AS eid, MAX(id)::int AS did
        FROM   sync_events
        WHERE  instance_id = ${inst.instance_id} AND operation = 'delete' AND entity_type IN (${Prisma.join(resyncTypes)})
        GROUP  BY 1, 2
      `);
      for (const r of rows) if (r.eid) cloudDeleted.set(`${r.entity_type}:${r.eid}`, Number(r.did));
    } catch (e: any) { console.warn('[sync] resync delete lookup failed:', e?.message); }
  }

  try {
    // Each item gets its own transaction: inside one shared Postgres transaction a single
    // failing statement aborts every later item and the whole batch 500s, so one bad
    // payload used to block the device's entire queue.
    for (const item of items) {
      try {
        if (!item || typeof item.entity_type !== 'string' || typeof item.operation !== 'string') {
          throw new Error('entity_type and operation are required');
        }
        const isResync = !!(item.payload as any)?._resync;
        const cleanPayload: Record<string, any> = isResync ? (({ _resync, ...rest }: any) => rest)(item.payload) : (item.payload || {});
        // Resync snapshot of a row the cloud deleted (and nobody re-created since) → drop it.
        // Sale lines from older PCs (no _resync flag): drop only when it is the SAME line coming back
        // (same bill, product, qty and price as the deleted one) — a genuinely new line that happens to
        // reuse the id belongs to another bill and is kept. Lines put back by support carry restored_lost_line.
        const unflaggedLine = !isResync && item.entity_type === 'sale_item' && item.operation !== 'delete' && !cleanPayload.restored_lost_line;
        if (unflaggedLine && cleanPayload.id != null) {
          const eid = String(cleanPayload.id);
          const did = cloudDeleted.get(`sale_item:${eid}`);
          if (did) {
            const [prev] = await prisma.$queryRaw<Array<{ payload: string; operation: string }>>(Prisma.sql`
              SELECT payload, operation FROM sync_events
              WHERE  instance_id = ${inst.instance_id} AND entity_type = 'sale_item' AND substring(payload from ${ID_RE}) = ${eid}
              ORDER  BY id DESC LIMIT 2
            `);
            // latest event is the delete itself → compare with the version before it
            if (prev?.operation === 'delete') {
              const [before] = await prisma.$queryRaw<Array<{ payload: string }>>(Prisma.sql`
                SELECT payload FROM sync_events
                WHERE  instance_id = ${inst.instance_id} AND entity_type = 'sale_item' AND id < ${did}
                  AND  operation <> 'delete' AND substring(payload from ${ID_RE}) = ${eid}
                ORDER  BY id DESC LIMIT 1
              `);
              let old: any = null; try { old = before ? JSON.parse(before.payload) : null; } catch { old = null; }
              const same = old && String(old.sale_id) === String(cleanPayload.sale_id) && String(old.product_id ?? '') === String(cleanPayload.product_id ?? '')
                && Number(old.quantity) === Number(cleanPayload.quantity) && Number(old.price) === Number(cleanPayload.price);
              if (same) { results.push({ local_id: item.local_id, success: true }); synced++; continue; }
            }
          }
        }
        if (isResync && item.operation !== 'delete' && cleanPayload.id != null) {
          const eid = String(cleanPayload.id);
          const did = cloudDeleted.get(`${item.entity_type}:${eid}`);
          if (did) {
            const [later] = await prisma.$queryRaw<[{ cnt: number }]>(Prisma.sql`
              SELECT COUNT(*)::int AS cnt FROM sync_events
              WHERE  instance_id = ${inst.instance_id} AND entity_type = ${item.entity_type}
                AND  id > ${did} AND operation <> 'delete' AND substring(payload from ${ID_RE}) = ${eid}
            `);
            if (!Number(later?.cnt ?? 0)) { results.push({ local_id: item.local_id, success: true }); synced++; continue; }
          }
        }
        // A \u0000 escape makes every later `payload::jsonb` cast in the read routes throw.
        const payloadStr = JSON.stringify(cleanPayload).replace(/\\u0000/g, '');

        await prisma.$transaction(async (tx) => {
          // Skip exact duplicate creates (full-resync re-pushes everything).
          let skipEvent = false;
          if (item.operation === 'create') {
            const [dup] = await tx.$queryRaw<[{ cnt: number }]>(Prisma.sql`
              SELECT COUNT(*)::int AS cnt
              FROM   sync_events
              WHERE  instance_id = ${inst.instance_id}
                AND  entity_type = ${item.entity_type}
                AND  operation   = 'create'
                AND  payload     = ${payloadStr}
              LIMIT 1
            `);
            if (Number(dup?.cnt ?? 0) > 0) skipEvent = true;
          }

          if (!skipEvent) {
            await tx.syncEvent.create({
              data: {
                instance_id: inst.instance_id,
                entity_type: item.entity_type,
                operation:   item.operation,
                payload:     payloadStr,
              },
            });
          }

          // instance_sales must follow every sale change (cancel, return, payment status),
          // not only the first create, or admin sales/revenue keep the original state forever.
          if (item.entity_type === 'sale') {
            const p      = cleanPayload;
            const saleNum = Number(p.id ?? p.sale_id);
            if (Number.isSafeInteger(saleNum) && saleNum > 0) {
              const saleId = BigInt(saleNum);
              const key = { instance_id_pos_sale_id: { instance_id: inst.instance_id, pos_sale_id: saleId } };
              if (item.operation === 'delete') {
                await tx.instanceSale.deleteMany({ where: { instance_id: inst.instance_id, pos_sale_id: saleId } });
              } else {
                const has = (k: string) => p[k] !== undefined && p[k] !== null;
                const itemsCount = has('item_count') ? p.item_count : (has('items_count') ? p.items_count : undefined);
                const common = {
                  total:          Number(p.total    || 0),
                  discount:       Number(p.discount || 0),
                  payment_method: p.payment_method  || 'cash',
                  payment_status: p.payment_status  || 'Paid',
                  status:         p.status          || 'Completed',
                  date_created:   p.date_created    || null,
                };
                await tx.instanceSale.upsert({
                  where:  key,
                  create: {
                    instance_id:   inst.instance_id,
                    pos_sale_id:   saleId,
                    ...common,
                    items_count:   Number(itemsCount || 0),
                    items_summary: p.items_summary || '',
                  },
                  // Update payloads are plain `SELECT * FROM sales` rows without the joined
                  // item fields — keep the stored ones instead of zeroing them.
                  update: {
                    ...common,
                    ...(itemsCount !== undefined ? { items_count: Number(itemsCount || 0) } : {}),
                    ...(has('items_summary') ? { items_summary: String(p.items_summary) } : {}),
                  },
                });
              }
              newSalesCount   = 1;
              newSalesRevenue = 1;
            }
          }
        });

        if (item.entity_type === 'customer') hasCustomerEvents = true;
        if (item.entity_type === 'product')  hasProductEvents  = true;

        results.push({ local_id: item.local_id, success: true });
        synced++;
      } catch (err: any) {
        results.push({ local_id: item?.local_id, success: false, error: err.message });
      }
    }

    await prisma.$transaction(async (tx) => {

      // Recount distinct customer / product IDs from sync_events for accurate totals
      let customerCount: number | null = null;
      let productCount:  number | null = null;

      // Count entities whose latest event is not a delete (create-only counts kept
      // deleted customers/products forever).
      const liveCount = async (entityType: string) => {
        const [row] = await tx.$queryRaw<[{ cnt: number }]>(Prisma.sql`
          SELECT COUNT(*)::int AS cnt FROM (
            SELECT DISTINCT ON (eid) operation
            FROM (
              SELECT id, operation, substring(payload from '"id":"?([^",}]*)') AS eid
              FROM   sync_events
              WHERE  instance_id = ${inst.instance_id}
                AND  entity_type = ${entityType}
            ) e
            WHERE eid IS NOT NULL
            ORDER BY eid, id DESC
          ) latest
          WHERE operation <> 'delete'
        `);
        return Number(row?.cnt ?? 0);
      };
      if (hasCustomerEvents) customerCount = await liveCount('customer');
      if (hasProductEvents)  productCount  = await liveCount('product');

      // ── Recalculate sale aggregates from source-of-truth ─────────────────────
      // NEVER use increment() for totals — re-syncing the same sale would inflate
      // the numbers. Always recount from instance_sales so the result is idempotent.
      let realSalesCount:   number | null = null;
      let realSalesRevenue: number | null = null;

      if (newSalesCount > 0) {
        const [agg] = await tx.$queryRaw<[{ cnt: bigint; rev: string }]>(Prisma.sql`
          SELECT COUNT(*)::int         AS cnt,
                 COALESCE(SUM(total), 0)::float AS rev
          FROM   instance_sales
          WHERE  instance_id = ${inst.instance_id}
            AND  LOWER(status) IN ('completed', 'paid', 'partial')
        `);
        realSalesCount   = Number(agg?.cnt ?? 0);
        realSalesRevenue = Number(agg?.rev ?? 0);
      }

      // Update instance aggregates
      await tx.instance.update({
        where: { instance_id: inst.instance_id },
        data: {
          last_seen:       new Date(),
          total_sales:     realSalesCount   != null ? realSalesCount   : undefined,
          total_revenue:   realSalesRevenue != null ? realSalesRevenue : undefined,
          total_customers: customerCount    != null ? customerCount    : undefined,
          total_products:  productCount     != null ? productCount     : undefined,
        },
      });
    }).catch((err: any) => {
      // Items are already stored; failing the response here would make the POS resend them.
      console.error('[sync] aggregate refresh failed:', err?.message);
    });

    res.json({ success: true, synced, total: items.length, results });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
