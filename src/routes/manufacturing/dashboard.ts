import { Router, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import prisma from '../../db';
import { requireManufacturingInstance } from './middleware';

const router = Router();

/**
 * GET /api/manufacturing/dashboard — [auth: Bearer api_key]
 *
 * Query params:
 *   start_date  — YYYY-MM-DD (inclusive), defaults to '1970-01-01'
 *   end_date    — YYYY-MM-DD (inclusive), defaults to today
 *
 * Returns:
 *   period      — sales/revenue filtered by the date range
 *   stats       — global entity counts + AR
 *   sales_trend — last 7 calendar days (always, regardless of period filter)
 */
router.get('/dashboard', requireManufacturingInstance, async (req: Request, res: Response) => {
  const inst = req.mfgInstance!;

  const today = new Date().toISOString().slice(0, 10);
  const startDate = (req.query.start_date as string) || '1970-01-01';
  const endDate   = (req.query.end_date   as string) || today;

  const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);

  try {
    // ── 1. Period-scoped sales stats ─────────────────────────────────────────
    const [periodAgg] = await prisma.$queryRaw<[{ cnt: bigint; revenue: string }]>(
      Prisma.sql`
        SELECT
          COUNT(*) FILTER (WHERE status NOT IN ('Cancelled', 'Returned')) AS cnt,
          COALESCE(SUM(total) FILTER (WHERE status NOT IN ('Cancelled', 'Returned')), 0)::float AS revenue
        FROM manufacturing_instance_sales
        WHERE instance_id   = ${inst.id}
          AND date_created IS NOT NULL
          AND date_created != ''
          AND LEFT(date_created, 10) BETWEEN ${startDate} AND ${endDate}
      `
    );

    // ── 2. Global AR + top debtors ───────────────────────────────────────────
    const [arAgg] = await prisma.$queryRaw<[{ ar: string }]>(
      Prisma.sql`
        SELECT COALESCE(SUM(total - paid_amount) FILTER (WHERE status IN ('Due', 'Partial')), 0)::float AS ar
        FROM   manufacturing_instance_sales
        WHERE  instance_id = ${inst.id}
      `
    );

    const topDebtors = await prisma.$queryRaw<Array<{ customer_name: string; due: string }>>(
      Prisma.sql`
        SELECT customer_name,
               SUM(total - paid_amount)::float AS due
        FROM   manufacturing_instance_sales
        WHERE  instance_id   = ${inst.id}
          AND  status        IN ('Due', 'Partial')
          AND  customer_name != ''
        GROUP  BY customer_name
        ORDER  BY due DESC
        LIMIT  5
      `
    );

    // ── 3. Sales trend — last 7 calendar days ────────────────────────────────
    const trendRows = await prisma.$queryRaw<Array<{ date: string; count: bigint; revenue: string }>>(
      Prisma.sql`
        SELECT LEFT(date_created, 10) AS date,
               COUNT(*)                AS count,
               COALESCE(SUM(total), 0)::float AS revenue
        FROM   manufacturing_instance_sales
        WHERE  instance_id   = ${inst.id}
          AND  status        NOT IN ('Cancelled', 'Returned')
          AND  date_created  IS NOT NULL
          AND  date_created  != ''
          AND  LEFT(date_created, 10) >= ${sevenDaysAgo}
        GROUP  BY LEFT(date_created, 10)
        ORDER  BY date ASC
      `
    );

    // Fill in zeros for any missing days in the 7-day window
    const trendMap: Record<string, { count: number; revenue: number }> = {};
    for (const r of trendRows) {
      trendMap[r.date] = { count: Number(r.count), revenue: Number(r.revenue) };
    }
    const salesTrend: Array<{ date: string; count: number; revenue: number }> = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
      salesTrend.push({ date: d, count: trendMap[d]?.count ?? 0, revenue: trendMap[d]?.revenue ?? 0 });
    }

    // ── 4. Cloud entity counts (distinct records, not deleted) ───────────────
    const countRows = await prisma.$queryRaw<Array<{ entity_type: string; cnt: bigint }>>(
      Prisma.sql`
        WITH latest AS (
          SELECT entity_type, local_id, operation,
                 ROW_NUMBER() OVER (
                   PARTITION BY entity_type, local_id ORDER BY id DESC
                 ) AS rn
          FROM   manufacturing_sync_events
          WHERE  instance_id = ${inst.id}
        )
        SELECT entity_type, COUNT(DISTINCT local_id) AS cnt
        FROM   latest
        WHERE  rn = 1 AND operation != 'delete'
        GROUP  BY entity_type
      `
    );
    const counts: Record<string, number> = {};
    for (const r of countRows) counts[r.entity_type] = Number(r.cnt);

    res.json({
      success: true,
      period: {
        sales_count: Number(periodAgg?.cnt ?? 0),
        revenue:     Number(periodAgg?.revenue ?? 0),
      },
      stats: {
        // Snapshot totals from the instance row (updated on each Electron sync)
        total_sales:    inst.total_sales,
        total_revenue:  inst.total_revenue,
        total_products: counts.product  ?? inst.total_products,
        total_parts:    counts.part     ?? inst.total_parts,
        low_stock_items: inst.low_stock_items,
        // From cloud event log
        total_purchases: counts.purchase ?? 0,
        total_customers: counts.customer ?? 0,
        total_vendors:   counts.vendor   ?? 0,
        // AR
        accounts_receivable: Number(arAgg?.ar ?? 0),
        top_debtors: topDebtors.map(d => ({
          customer_name: d.customer_name,
          due: Number(d.due),
        })),
      },
      sales_trend: salesTrend,
    });
  } catch (err: any) {
    console.error('[manufacturing/dashboard]', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
