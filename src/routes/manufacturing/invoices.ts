import { Router, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import prisma from '../../db';
import { requireManufacturingInstance } from './middleware';

const router = Router();

/**
 * GET /api/manufacturing/invoices — [auth: Bearer api_key]
 *
 * Reads the latest sync event per (entity_type, local_id) for sale and purchase
 * entities (last-write-wins), parses the JSON payloads, applies optional filters,
 * and returns paginated invoice headers. Line items are NOT included — the Electron
 * app only syncs invoice headers, not sale_items / purchase_invoice_items rows.
 *
 * Query params:
 *   type    — 'sale' | 'purchase' | 'all' (default: 'all')
 *   status  — Paid | Partial | Due | Cancelled | Returned | 'all' (default: 'all')
 *   search  — partial match on invoice_number, customer_name, or vendor_name
 *   page    — 1-based page number (default: 1)
 *   limit   — records per page, max 200 (default: 50)
 */
router.get('/invoices', requireManufacturingInstance, async (req: Request, res: Response) => {
  const inst = req.mfgInstance!;
  const { type, status, search } = req.query as Record<string, string>;
  const page  = Math.max(1,   parseInt((req.query.page  as string) || '1')  || 1);
  const limit = Math.min(200, parseInt((req.query.limit as string) || '50') || 50);

  try {
    // Latest event per (entity_type, local_id); exclude deletes.
    const entityTypes = (!type || type === 'all')
      ? ['sale', 'purchase']
      : [type];

    const rows = await prisma.$queryRaw<Array<{
      entity_type: string;
      local_id:    number;
      payload:     string;
      received_at: Date;
    }>>(Prisma.sql`
      WITH latest AS (
        SELECT
          entity_type,
          local_id,
          payload,
          received_at,
          operation,
          ROW_NUMBER() OVER (
            PARTITION BY entity_type, local_id
            ORDER BY id DESC
          ) AS rn
        FROM manufacturing_sync_events
        WHERE instance_id = ${inst.id}
          AND entity_type = ANY(${entityTypes}::text[])
      )
      SELECT entity_type, local_id, payload, received_at
      FROM   latest
      WHERE  rn = 1 AND operation != 'delete'
      ORDER  BY received_at DESC
    `);

    // Parse JSON payloads and normalise into a flat invoice shape.
    type Invoice = {
      id: number;
      type: 'sale' | 'purchase';
      invoice_number: string;
      created_at: string;
      edited_at: string | null;
      customer_name: string;
      customer_phone: string;
      customer_address: string;
      vendor_name: string;
      vendor_id: number | null;
      subtotal: number;
      discount: number;
      tax: number;
      transport: number;
      total: number;
      paid_amount: number;
      payment_method: string;
      status: string;
      account_id: number | null;
      notes: string;
    };

    let invoices: Invoice[] = rows.map(r => {
      let p: Record<string, any> = {};
      try { p = JSON.parse(r.payload as any); } catch {}

      const receivedAt = r.received_at instanceof Date
        ? r.received_at.toISOString()
        : String(r.received_at);

      if (r.entity_type === 'sale') {
        return {
          id:               Number(r.local_id),
          type:             'sale' as const,
          invoice_number:   String(p.invoice_number || `SI-${r.local_id}`),
          created_at:       String(p.created_at || receivedAt),
          edited_at:        p.edited_at ? String(p.edited_at) : null,
          customer_name:    String(p.customer_name    || ''),
          customer_phone:   String(p.customer_phone   || ''),
          customer_address: String(p.customer_address || ''),
          vendor_name:      '',
          vendor_id:        null,
          subtotal:     Number(p.subtotal     || p.total || 0),
          discount:     Number(p.discount     || 0),
          tax:          Number(p.tax          || 0),
          transport:    0,
          total:        Number(p.total        || 0),
          paid_amount:  Number(p.paid_amount  || 0),
          payment_method: String(p.payment_method || 'Cash'),
          status:         String(p.status         || 'Paid'),
          account_id:     p.account_id != null ? Number(p.account_id) : null,
          notes:          '',
        };
      } else {
        return {
          id:               Number(r.local_id),
          type:             'purchase' as const,
          invoice_number:   String(p.invoice_number || `PI-${r.local_id}`),
          created_at:       String(p.created_at || receivedAt),
          edited_at:        p.edited_at ? String(p.edited_at) : null,
          customer_name:    '',
          customer_phone:   '',
          customer_address: '',
          vendor_name:    String(p.vendor_name || ''),
          vendor_id:      p.vendor_id != null ? Number(p.vendor_id) : null,
          subtotal:     Number(p.subtotal     || p.total || 0),
          discount:     Number(p.discount     || 0),
          tax:          0,
          transport:    Number(p.transport    || 0),
          total:        Number(p.total        || 0),
          paid_amount:  Number(p.paid_amount  || 0),
          payment_method: String(p.payment_method || 'Cash'),
          status:         String(p.status         || 'Partial'),
          account_id:     p.account_id != null ? Number(p.account_id) : null,
          notes:          String(p.notes || ''),
        };
      }
    });

    // Apply status filter
    if (status && status !== 'all') {
      invoices = invoices.filter(inv => inv.status === status);
    }

    // Apply search filter
    if (search) {
      const q = search.toLowerCase();
      invoices = invoices.filter(inv =>
        inv.invoice_number.toLowerCase().includes(q) ||
        inv.customer_name.toLowerCase().includes(q) ||
        inv.vendor_name.toLowerCase().includes(q)
      );
    }

    // Paginate
    const total_count = invoices.length;
    const total_pages = Math.ceil(total_count / limit) || 1;
    const data = invoices.slice((page - 1) * limit, page * limit);

    res.json({
      success: true,
      data,
      pagination: { page, limit, total_count, total_pages },
    });
  } catch (err: any) {
    console.error('[manufacturing/invoices]', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
