import { Router, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import prisma from '../../db';
import { requireManufacturingInstance } from './middleware';

const router = Router();

interface SyncItem {
  entity_type: string;   // sale | purchase | product | part | customer | vendor
  operation: string;     // create | update | delete
  payload: Record<string, any>;
  local_id?: number;
}

/**
 * POST /api/manufacturing/sync — [auth: Bearer api_key]
 *
 * Two shapes are accepted on the same route for backward compatibility:
 *  - { items: SyncItem[] }  — batch record-level push (Electron app's cloud_sync_queue
 *    drain, mirrors the POS's /api/sync). Each item is stored as a raw event; sale
 *    creates are also flattened into ManufacturingInstanceSale. Instance aggregate
 *    counters are recalculated from source-of-truth (never incremented) so re-syncs
 *    stay idempotent.
 *  - { total_sales, total_revenue, total_products, total_parts, low_stock_items } —
 *    legacy lightweight snapshot (Settings page "Cloud Sync" button).
 */
router.post('/sync', requireManufacturingInstance, async (req: Request, res: Response) => {
  const inst = req.mfgInstance!;

  const { items } = req.body as { items?: SyncItem[] };

  if (Array.isArray(items)) {
    if (items.length === 0) { res.status(400).json({ success: false, error: 'items array must not be empty' }); return; }
    if (items.length > 100) { res.status(400).json({ success: false, error: 'Maximum 100 items per sync batch' }); return; }

    const results: Array<{ local_id?: number; success: boolean; error?: string }> = [];
    let synced = 0;
    let touchedSales = false;

    try {
      await prisma.$transaction(async (tx) => {
        for (const item of items) {
          try {
            const payloadStr = JSON.stringify(item.payload || {});
            const entityId = String(item.payload?.id ?? '');

            // Skip exact duplicate creates — the client's periodic full-resync (if any)
            // would otherwise keep re-appending identical events.
            let skipEvent = false;
            if (entityId && item.operation === 'create') {
              const [dup] = await tx.$queryRaw<[{ cnt: bigint }]>(Prisma.sql`
                SELECT COUNT(*)::int AS cnt
                FROM   manufacturing_sync_events
                WHERE  instance_id = ${inst.id}
                  AND  entity_type = ${item.entity_type}
                  AND  operation   = 'create'
                  AND  payload::jsonb->>'id' IS NOT DISTINCT FROM ${entityId}
                  AND  payload = ${payloadStr}
                LIMIT 1
              `);
              if (Number(dup?.cnt ?? 0) > 0) skipEvent = true;
            }

            if (!skipEvent) {
              await tx.manufacturingSyncEvent.create({
                data: {
                  instance_id: inst.id,
                  entity_type: item.entity_type,
                  operation: item.operation,
                  local_id: item.local_id ?? (item.payload?.id ? Number(item.payload.id) : null),
                  payload: payloadStr,
                },
              });
            }

            // Flatten sale creates/updates into manufacturing_instance_sales (upsert — idempotent)
            if (item.entity_type === 'sale' && (item.operation === 'create' || item.operation === 'update')) {
              const p = item.payload;
              const saleId = p.id;
              if (saleId) {
                await tx.manufacturingInstanceSale.upsert({
                  where: { instance_id_local_sale_id: { instance_id: inst.id, local_sale_id: Number(saleId) } },
                  create: {
                    instance_id: inst.id,
                    local_sale_id: Number(saleId),
                    total: Number(p.total || 0),
                    paid_amount: Number(p.paid_amount || 0),
                    payment_method: p.payment_method || 'Cash',
                    status: p.status || 'Completed',
                    customer_name: p.customer_name || '',
                    items_count: Number(p.items_count || 0),
                    date_created: p.created_at || null,
                  },
                  update: {
                    total: Number(p.total || 0),
                    paid_amount: Number(p.paid_amount || 0),
                    payment_method: p.payment_method || 'Cash',
                    status: p.status || 'Completed',
                    customer_name: p.customer_name || '',
                    date_created: p.created_at || null,
                  },
                });
                touchedSales = true;
              }
            }

            results.push({ local_id: item.local_id, success: true });
            synced++;
          } catch (err: any) {
            results.push({ local_id: item.local_id, success: false, error: err.message });
          }
        }

        // Recalculate every aggregate from source-of-truth — never increment(),
        // so a re-sync of the same batch can never inflate the numbers.
        const [salesAgg] = await tx.$queryRaw<[{ cnt: bigint; rev: string }]>(Prisma.sql`
          SELECT COUNT(*)::int AS cnt, COALESCE(SUM(total), 0)::float AS rev
          FROM   manufacturing_instance_sales
          WHERE  instance_id = ${inst.id} AND status NOT IN ('Cancelled', 'Returned')
        `);
        const [productRow] = await tx.$queryRaw<[{ cnt: bigint }]>(Prisma.sql`
          SELECT COUNT(DISTINCT (payload::jsonb)->>'id')::int AS cnt
          FROM manufacturing_sync_events
          WHERE instance_id = ${inst.id} AND entity_type = 'product' AND operation = 'create'
        `);
        const [partRow] = await tx.$queryRaw<[{ cnt: bigint }]>(Prisma.sql`
          SELECT COUNT(DISTINCT (payload::jsonb)->>'id')::int AS cnt
          FROM manufacturing_sync_events
          WHERE instance_id = ${inst.id} AND entity_type = 'part' AND operation = 'create'
        `);

        await tx.manufacturingInstance.update({
          where: { id: inst.id },
          data: {
            last_seen: new Date(),
            total_sales: touchedSales ? Number(salesAgg?.cnt ?? 0) : undefined,
            total_revenue: touchedSales ? Number(salesAgg?.rev ?? 0) : undefined,
            total_products: Number(productRow?.cnt ?? 0),
            total_parts: Number(partRow?.cnt ?? 0),
          },
        });
      });

      res.json({ success: true, synced, total: items.length, results });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
    return;
  }

  // Legacy lightweight snapshot shape
  const { total_sales, total_revenue, total_products, total_parts, low_stock_items } = req.body as Record<string, number>;
  await prisma.manufacturingInstance.update({
    where: { id: inst.id },
    data: {
      total_sales: total_sales ?? undefined,
      total_revenue: total_revenue ?? undefined,
      total_products: total_products ?? undefined,
      total_parts: total_parts ?? undefined,
      low_stock_items: low_stock_items ?? undefined,
      last_seen: new Date(),
    },
  });
  res.json({ success: true });
});

/**
 * GET /api/manufacturing/cloud-counts — [auth: Bearer api_key]
 *
 * Returns the count of DISTINCT records currently live in the cloud for each
 * entity type (sale/purchase/product/part/customer/vendor) — latest event per
 * local_id wins, and anything whose latest event is a delete is excluded.
 * Powers the "Local vs Cloud" comparison table in the Electron app's Settings page.
 */
router.get('/cloud-counts', requireManufacturingInstance, async (req: Request, res: Response) => {
  const inst = req.mfgInstance!;

  const rows = await prisma.$queryRaw<Array<{ entity_type: string; distinct_count: bigint }>>(
    Prisma.sql`
      WITH latest AS (
        SELECT entity_type,
               local_id,
               operation,
               ROW_NUMBER() OVER (
                 PARTITION BY entity_type, local_id
                 ORDER BY id DESC
               ) AS rn
        FROM   manufacturing_sync_events
        WHERE  instance_id = ${inst.id}
      )
      SELECT entity_type,
             COUNT(DISTINCT local_id) AS distinct_count
      FROM   latest
      WHERE  rn = 1
        AND  operation != 'delete'
      GROUP  BY entity_type
    `
  );

  const counts: Record<string, number> = {};
  for (const row of rows) {
    counts[row.entity_type] = Number(row.distinct_count ?? 0);
  }

  res.json({ success: true, data: counts });
});

export default router;
