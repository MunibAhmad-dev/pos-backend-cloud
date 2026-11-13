import { Router, Request, Response } from 'express';
import prisma from '../db';
import { requireInstance } from '../middleware/instanceAuth';
import '../types';

const router = Router();

// ─── Helpers ─────────────────────────────────────────────────────────────────

function reconstructFromEvents(events: Array<{ operation: string; payload: string }>): Map<string, any> {
  const map = new Map<string, any>();
  for (const ev of events) {
    let payload: any;
    try { payload = JSON.parse(ev.payload); } catch { continue; }
    const key = String(payload?.id ?? '');
    if (!key) continue;
    if (ev.operation === 'delete') map.delete(key);
    else map.set(key, payload);
  }
  return map;
}

// ─── Vendor Khata (custom debt ledger) ───────────────────────────────────────

/**
 * GET /api/vendors/khata   [instanceAuth]
 * Query: vendor_id (required)
 *
 * Returns all open khata entries for a vendor with payment totals,
 * reconstructed from cloud sync events.
 */
router.get('/khata', requireInstance, async (req: Request, res: Response) => {
  const instanceId = req.instance!.instance_id;
  const vendorId = req.query.vendor_id as string;

  if (!vendorId) {
    res.status(400).json({ success: false, error: 'vendor_id is required' });
    return;
  }

  const [khataEvents, paymentEvents] = await Promise.all([
    prisma.syncEvent.findMany({
      where:   { instance_id: instanceId, entity_type: 'vendor_khata' },
      orderBy: { id: 'asc' },
      select:  { operation: true, payload: true },
    }),
    prisma.syncEvent.findMany({
      where:   { instance_id: instanceId, entity_type: 'vendor_khata_payment' },
      orderBy: { id: 'asc' },
      select:  { operation: true, payload: true },
    }),
  ]);

  const khataMap = reconstructFromEvents(khataEvents);

  // Filter to requested vendor
  const vendorKhata = Array.from(khataMap.values()).filter(k => String(k.vendor_id) === vendorId);

  if (vendorKhata.length === 0) {
    res.json({ success: true, data: [] });
    return;
  }

  // Accumulate payments per khata id (live events only — deletes subtract)
  const khataIds = new Set(vendorKhata.map(k => String(k.id)));
  const paidByKhata = new Map<string, number>();

  // Latest version per payment id — summing every event counted edits twice, and delete
  // events carry only {id}, so deleted payments were never subtracted.
  for (const p of reconstructFromEvents(paymentEvents).values()) {
    const kid = String(p?.khata_id ?? '');
    if (!khataIds.has(kid)) continue;
    paidByKhata.set(kid, (paidByKhata.get(kid) ?? 0) + Number(p?.amount ?? 0));
  }

  const data = vendorKhata.map(k => {
    const paid = paidByKhata.get(String(k.id)) ?? 0;
    return { ...k, amount_paid: paid, balance_due: Number(k.total_amount ?? 0) - paid };
  });

  res.json({ success: true, data });
});

/**
 * GET /api/vendors/khata/:khataId/payments   [instanceAuth]
 *
 * Returns all payments recorded against a specific khata entry.
 */
router.get('/khata/:khataId/payments', requireInstance, async (req: Request, res: Response) => {
  const instanceId = req.instance!.instance_id;
  const { khataId } = req.params;

  const events = await prisma.syncEvent.findMany({
    where:   { instance_id: instanceId, entity_type: 'vendor_khata_payment' },
    orderBy: { id: 'asc' },
    select:  { operation: true, payload: true },
  });

  const payments = Array.from(reconstructFromEvents(events).values())
    .filter((p: any) => String(p?.khata_id) === khataId);

  res.json({ success: true, data: payments });
});

/**
 * GET /api/vendors/khata/summary   [instanceAuth]
 *
 * Returns per-vendor totals: total_khata, total_khata_paid, khata_balance.
 * Useful for admin dashboards showing outstanding vendor debts across the store.
 */
router.get('/khata/summary', requireInstance, async (req: Request, res: Response) => {
  const instanceId = req.instance!.instance_id;

  const [khataEvents, paymentEvents] = await Promise.all([
    prisma.syncEvent.findMany({
      where:   { instance_id: instanceId, entity_type: 'vendor_khata' },
      orderBy: { id: 'asc' },
      select:  { operation: true, payload: true },
    }),
    prisma.syncEvent.findMany({
      where:   { instance_id: instanceId, entity_type: 'vendor_khata_payment' },
      orderBy: { id: 'asc' },
      select:  { operation: true, payload: true },
    }),
  ]);

  const khataMap = reconstructFromEvents(khataEvents);

  // Group khata total_amount by vendor_id
  const totalByVendor = new Map<string, number>();
  for (const k of khataMap.values()) {
    if (String(k.status ?? '').toLowerCase() === 'closed') continue;
    const vid = String(k.vendor_id ?? '');
    totalByVendor.set(vid, (totalByVendor.get(vid) ?? 0) + Number(k.total_amount ?? 0));
  }

  // Accumulate payments by khata_id → then map to vendor_id
  const khataToVendor = new Map<string, string>();
  for (const k of khataMap.values()) if (String(k.status ?? '').toLowerCase() !== 'closed') khataToVendor.set(String(k.id), String(k.vendor_id ?? ''));

  const paidByVendor = new Map<string, number>();
  for (const p of reconstructFromEvents(paymentEvents).values()) {
    const kid = String(p?.khata_id ?? '');
    const vid = khataToVendor.get(kid);
    if (!vid) continue;
    paidByVendor.set(vid, (paidByVendor.get(vid) ?? 0) + Number(p?.amount ?? 0));
  }

  const data = Array.from(totalByVendor.entries()).map(([vendor_id, total_khata]) => {
    const total_paid = paidByVendor.get(vendor_id) ?? 0;
    return { vendor_id, total_khata, total_khata_paid: total_paid, khata_balance: total_khata - total_paid };
  });

  res.json({ success: true, data });
});

export default router;
