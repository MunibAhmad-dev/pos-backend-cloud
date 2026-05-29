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

  try {
    await prisma.$transaction(async (tx) => {
      for (const item of items) {
        try {
          const payloadStr = JSON.stringify(item.payload || {});

          // Always store the raw event
          await tx.syncEvent.create({
            data: {
              instance_id: inst.instance_id,
              entity_type: item.entity_type,
              operation:   item.operation,
              payload:     payloadStr,
            },
          });

          // Flatten sale creates into instance_sales
          if (item.entity_type === 'sale' && item.operation === 'create') {
            const p      = item.payload;
            const saleId = p.id ?? p.sale_id;
            if (saleId) {
              await tx.instanceSale.upsert({
                where:  { instance_id_pos_sale_id: { instance_id: inst.instance_id, pos_sale_id: Number(saleId) } },
                create: {
                  instance_id:    inst.instance_id,
                  pos_sale_id:    Number(saleId),
                  total:          Number(p.total          || 0),
                  discount:       Number(p.discount       || 0),
                  payment_method: p.payment_method        || 'cash',
                  payment_status: p.payment_status        || 'Paid',
                  status:         p.status                || 'Completed',
                  items_count:    Number(p.item_count || p.items_count || 0),
                  items_summary:  p.items_summary         || '',
                  date_created:   p.date_created          || null,
                },
                update: {
                  total:          Number(p.total          || 0),
                  discount:       Number(p.discount       || 0),
                  payment_method: p.payment_method        || 'cash',
                  payment_status: p.payment_status        || 'Paid',
                  status:         p.status                || 'Completed',
                  items_count:    Number(p.item_count || p.items_count || 0),
                  items_summary:  p.items_summary         || '',
                  date_created:   p.date_created          || null,
                },
              });

              if ((p.status || 'Completed') === 'Completed') {
                newSalesRevenue += Number(p.total || 0);
                newSalesCount   += 1;
              }
            }
          }

          if (item.entity_type === 'customer') hasCustomerEvents = true;
          if (item.entity_type === 'product')  hasProductEvents  = true;

          results.push({ local_id: item.local_id, success: true });
          synced++;
        } catch (err: any) {
          results.push({ local_id: item.local_id, success: false, error: err.message });
        }
      }

      // Recount distinct customer / product IDs from sync_events for accurate totals
      let customerCount: number | null = null;
      let productCount:  number | null = null;

      if (hasCustomerEvents) {
        const [row] = await tx.$queryRaw<[{ cnt: bigint }]>(Prisma.sql`
          SELECT COUNT(DISTINCT (payload::jsonb)->>'id')::int AS cnt
          FROM sync_events
          WHERE instance_id = ${inst.instance_id}
            AND entity_type = 'customer'
            AND operation   = 'create'
        `);
        customerCount = Number(row?.cnt ?? 0);
      }

      if (hasProductEvents) {
        const [row] = await tx.$queryRaw<[{ cnt: bigint }]>(Prisma.sql`
          SELECT COUNT(DISTINCT (payload::jsonb)->>'id')::int AS cnt
          FROM sync_events
          WHERE instance_id = ${inst.instance_id}
            AND entity_type = 'product'
            AND operation   = 'create'
        `);
        productCount = Number(row?.cnt ?? 0);
      }

      // Update instance aggregates
      await tx.instance.update({
        where: { instance_id: inst.instance_id },
        data: {
          last_seen:       new Date(),
          total_sales:     newSalesCount    > 0 ? { increment: newSalesCount }    : undefined,
          total_revenue:   newSalesRevenue  > 0 ? { increment: newSalesRevenue }  : undefined,
          total_customers: customerCount != null ? customerCount : undefined,
          total_products:  productCount  != null ? productCount  : undefined,
        },
      });
    });

    res.json({ success: true, synced, total: items.length, results });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
