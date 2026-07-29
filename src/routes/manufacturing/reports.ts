import { Router, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import prisma from '../../db';
import { requireManufacturingInstance } from './middleware';

const router = Router();

/**
 * GET /api/manufacturing/reports — [auth: Bearer api_key]
 *
 * Query params:
 *   period     — 'today' | 'week' | 'month' (ignored when start_date is provided)
 *   start_date — YYYY-MM-DD
 *   end_date   — YYYY-MM-DD
 *
 * Returns overview KPIs, revenue trend, stock snapshot, customer breakdown,
 * and vendor breakdown for the given period.
 *
 * NOTE: COGS is approximated using purchase invoice totals (materials cost)
 * because sale line-items are not synced to the cloud by the Electron app.
 * Expenses are also not synced, so they appear as 0.
 */
router.get('/reports', requireManufacturingInstance, async (req: Request, res: Response) => {
  const inst = req.mfgInstance!;
  const today = new Date().toISOString().slice(0, 10);

  // Resolve date range
  let startDate: string;
  let endDate: string = today;

  if (req.query.start_date) {
    startDate = req.query.start_date as string;
    endDate   = (req.query.end_date as string) || today;
  } else {
    const period = (req.query.period as string) || 'month';
    if (period === 'today') {
      startDate = today;
    } else if (period === 'week') {
      const d = new Date(); d.setDate(d.getDate() - 6);
      startDate = d.toISOString().slice(0, 10);
    } else {
      // month — first day of current month
      const d = new Date(); d.setDate(1);
      startDate = d.toISOString().slice(0, 10);
    }
  }

  try {
    // ── 1. Revenue from manufacturing_instance_sales ──────────────────────────
    const [revAgg] = await prisma.$queryRaw<[{
      total: string; cnt: bigint; avg_order: string; ar: string;
    }]>(Prisma.sql`
      SELECT
        COALESCE(SUM(total)  FILTER (WHERE status NOT IN ('Cancelled','Returned')), 0)::float AS total,
        COUNT(*)             FILTER (WHERE status NOT IN ('Cancelled','Returned'))             AS cnt,
        COALESCE(AVG(total)  FILTER (WHERE status NOT IN ('Cancelled','Returned')), 0)::float AS avg_order,
        COALESCE(SUM(total - paid_amount) FILTER (WHERE status IN ('Due','Partial')), 0)::float AS ar
      FROM manufacturing_instance_sales
      WHERE instance_id   = ${inst.id}
        AND date_created IS NOT NULL
        AND date_created != ''
        AND LEFT(date_created, 10) BETWEEN ${startDate} AND ${endDate}
    `);

    // ── 2. Purchases / materials cost (COGS approximation) ───────────────────
    const [purchAgg] = await prisma.$queryRaw<[{
      total: string; cnt: bigint;
    }]>(Prisma.sql`
      WITH latest AS (
        SELECT local_id, payload, operation,
          ROW_NUMBER() OVER (PARTITION BY local_id ORDER BY id DESC) AS rn
        FROM manufacturing_sync_events
        WHERE instance_id = ${inst.id} AND entity_type = 'purchase'
      )
      SELECT
        COALESCE(SUM((payload::jsonb->>'total')::float)
          FILTER (WHERE (payload::jsonb->>'status') NOT IN ('Cancelled')), 0)::float AS total,
        COUNT(*) FILTER (WHERE (payload::jsonb->>'status') NOT IN ('Cancelled')) AS cnt
      FROM latest
      WHERE rn = 1 AND operation != 'delete'
        AND (payload::jsonb->>'created_at') IS NOT NULL
        AND LEFT((payload::jsonb->>'created_at'), 10) BETWEEN ${startDate} AND ${endDate}
    `);

    // ── 3. Revenue trend (daily) ──────────────────────────────────────────────
    const trendRows = await prisma.$queryRaw<Array<{
      date: string; revenue: string; orders: bigint;
    }>>(Prisma.sql`
      SELECT
        LEFT(date_created, 10) AS date,
        COALESCE(SUM(total), 0)::float AS revenue,
        COUNT(*) AS orders
      FROM manufacturing_instance_sales
      WHERE instance_id = ${inst.id}
        AND status NOT IN ('Cancelled','Returned')
        AND date_created IS NOT NULL
        AND date_created != ''
        AND LEFT(date_created, 10) BETWEEN ${startDate} AND ${endDate}
      GROUP BY LEFT(date_created, 10)
      ORDER BY date ASC
    `);

    const trendMap: Record<string, { revenue: number; orders: number }> = {};
    for (const r of trendRows) trendMap[r.date] = { revenue: Number(r.revenue), orders: Number(r.orders) };

    const revenueTrend: Array<{ date: string; revenue: number; orders: number }> = [];
    const msPerDay = 86_400_000;
    const startMs = new Date(startDate).getTime();
    const endMs   = new Date(endDate).getTime();
    for (let ms = startMs; ms <= endMs; ms += msPerDay) {
      const d = new Date(ms).toISOString().slice(0, 10);
      revenueTrend.push({ date: d, revenue: trendMap[d]?.revenue ?? 0, orders: trendMap[d]?.orders ?? 0 });
    }

    // ── 4. Stock snapshot (latest product + part payloads) ────────────────────
    const productRows = await prisma.$queryRaw<Array<{ payload: string }>>(Prisma.sql`
      WITH latest AS (
        SELECT payload, operation,
          ROW_NUMBER() OVER (PARTITION BY local_id ORDER BY id DESC) AS rn
        FROM manufacturing_sync_events
        WHERE instance_id = ${inst.id} AND entity_type = 'product'
      )
      SELECT payload FROM latest WHERE rn = 1 AND operation != 'delete'
    `);
    const partRows = await prisma.$queryRaw<Array<{ payload: string }>>(Prisma.sql`
      WITH latest AS (
        SELECT payload, operation,
          ROW_NUMBER() OVER (PARTITION BY local_id ORDER BY id DESC) AS rn
        FROM manufacturing_sync_events
        WHERE instance_id = ${inst.id} AND entity_type = 'part'
      )
      SELECT payload FROM latest WHERE rn = 1 AND operation != 'delete'
    `);

    const parsePayloads = (rows: Array<{ payload: string }>) =>
      rows.map(r => { try { return JSON.parse(r.payload as any); } catch { return null; } }).filter(Boolean);

    const products = parsePayloads(productRows);
    const parts    = parsePayloads(partRows);
    const LOW = 5;
    const lowStockCount = products.filter((p: any) => Number(p.stock ?? 0) <= Number(p.low_stock_threshold ?? LOW)).length
                        + parts.filter((p: any)    => Number(p.stock ?? 0) <= Number(p.low_stock_threshold ?? LOW)).length;

    // ── 5. Customer breakdown ─────────────────────────────────────────────────
    const customerRows = await prisma.$queryRaw<Array<{
      customer_name: string; total_revenue: string; order_count: bigint; outstanding: string;
    }>>(Prisma.sql`
      SELECT
        COALESCE(NULLIF(TRIM(customer_name),''), 'Walk-in') AS customer_name,
        SUM(total)::float AS total_revenue,
        COUNT(*) AS order_count,
        COALESCE(SUM(total - paid_amount) FILTER (WHERE status IN ('Due','Partial')), 0)::float AS outstanding
      FROM manufacturing_instance_sales
      WHERE instance_id = ${inst.id}
        AND status NOT IN ('Cancelled','Returned')
        AND date_created IS NOT NULL
        AND date_created != ''
        AND LEFT(date_created, 10) BETWEEN ${startDate} AND ${endDate}
      GROUP BY COALESCE(NULLIF(TRIM(customer_name),''), 'Walk-in')
      ORDER BY total_revenue DESC
      LIMIT 20
    `);

    // ── 6. Vendor breakdown ───────────────────────────────────────────────────
    const vendorRows = await prisma.$queryRaw<Array<{
      vendor_name: string; total_spent: string; invoice_count: bigint; outstanding: string;
    }>>(Prisma.sql`
      WITH latest AS (
        SELECT local_id, payload, operation,
          ROW_NUMBER() OVER (PARTITION BY local_id ORDER BY id DESC) AS rn
        FROM manufacturing_sync_events
        WHERE instance_id = ${inst.id} AND entity_type = 'purchase'
      )
      SELECT
        COALESCE(NULLIF(TRIM(payload::jsonb->>'vendor_name'),''), 'Unknown') AS vendor_name,
        COALESCE(SUM((payload::jsonb->>'total')::float)
          FILTER (WHERE (payload::jsonb->>'status') NOT IN ('Cancelled')), 0)::float AS total_spent,
        COUNT(*) FILTER (WHERE (payload::jsonb->>'status') NOT IN ('Cancelled')) AS invoice_count,
        COALESCE(SUM(
          ((payload::jsonb->>'total')::float - (payload::jsonb->>'paid_amount')::float)
        ) FILTER (WHERE (payload::jsonb->>'status') IN ('Due','Partial')), 0)::float AS outstanding
      FROM latest
      WHERE rn = 1 AND operation != 'delete'
      GROUP BY payload::jsonb->>'vendor_name'
      ORDER BY total_spent DESC
      LIMIT 20
    `);

    // ── Assemble response ─────────────────────────────────────────────────────
    const revenue     = Number(revAgg?.total     ?? 0);
    const ordersCount = Number(revAgg?.cnt        ?? 0);
    const avgOrder    = Number(revAgg?.avg_order  ?? 0);
    const ar          = Number(revAgg?.ar          ?? 0);
    const cogs        = Number(purchAgg?.total    ?? 0);
    const netProfit   = revenue - cogs;
    const marginPct   = revenue > 0 ? (netProfit / revenue) * 100 : 0;
    const cogsPct     = revenue > 0 ? (cogs / revenue) * 100 : 0;

    res.json({
      success: true,
      period: { start_date: startDate, end_date: endDate },
      overview: {
        revenue,
        orders_count:        ordersCount,
        avg_order:           avgOrder,
        cogs,
        cogs_pct:            cogsPct,
        expenses:            0,
        net_profit:          netProfit,
        margin_pct:          marginPct,
        stock_bought:        cogs,
        accounts_receivable: ar,
        revenue_trend:       revenueTrend,
      },
      stock: {
        products: products.slice(0, 60).map((p: any) => ({
          id:   p.id,
          name: p.name,
          stock: Number(p.stock ?? 0),
          price: Number(p.price ?? 0),
          purchase_price: Number(p.purchase_price ?? 0),
          low_stock_threshold: Number(p.low_stock_threshold ?? LOW),
          category: p.category ?? '',
        })),
        parts: parts.slice(0, 60).map((p: any) => ({
          id:   p.id,
          name: p.name,
          stock: Number(p.stock ?? 0),
          unit:  p.unit ?? 'pc',
          cost_price: Number(p.cost_price ?? 0),
          low_stock_threshold: Number(p.low_stock_threshold ?? LOW),
          category: p.category ?? '',
        })),
        products_count: products.length,
        parts_count:    parts.length,
        low_stock_count: lowStockCount,
      },
      customers: customerRows.map(r => ({
        customer_name: r.customer_name,
        total_revenue: Number(r.total_revenue),
        order_count:   Number(r.order_count),
        outstanding:   Number(r.outstanding),
      })),
      vendors: vendorRows.map(r => ({
        vendor_name:   r.vendor_name,
        total_spent:   Number(r.total_spent),
        invoice_count: Number(r.invoice_count),
        outstanding:   Number(r.outstanding),
      })),
    });
  } catch (err: any) {
    console.error('[manufacturing/reports]', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
