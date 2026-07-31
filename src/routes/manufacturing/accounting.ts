import { Router, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import prisma from '../../db';
import { requireManufacturingInstance } from './middleware';

const router = Router();

function parseRows(rows: Array<{ payload: string }>): any[] {
  return rows
    .map(r => { try { return JSON.parse(r.payload as any); } catch { return null; } })
    .filter(Boolean);
}

function normaliseAccount(p: any, currentBalance?: number) {
  return {
    id:              p.id,
    name:            p.name || '',
    type:            p.type || 'cash',
    opening_balance: Number(p.opening_balance || 0),
    bank_name:       p.bank_name || '',
    account_number:  p.account_number || '',
    notes:           p.notes || '',
    is_default:      p.is_default ? 1 : 0,
    created_at:      p.created_at || null,
    current_balance: currentBalance !== undefined ? currentBalance : Number(p.current_balance || p.opening_balance || 0),
  };
}

/** GET /api/manufacturing/accounts */
router.get('/accounts', requireManufacturingInstance, async (req: Request, res: Response) => {
  const inst = req.mfgInstance!;
  try {
    const [accountRows, txnRows] = await Promise.all([
      prisma.$queryRaw<Array<{ payload: string }>>(Prisma.sql`
        WITH latest AS (
          SELECT payload, operation,
            ROW_NUMBER() OVER (PARTITION BY local_id ORDER BY id DESC) AS rn
          FROM manufacturing_sync_events
          WHERE instance_id = ${inst.id} AND entity_type = 'account'
        )
        SELECT payload FROM latest WHERE rn = 1 AND operation != 'delete'
      `),
      prisma.$queryRaw<Array<{ payload: string }>>(Prisma.sql`
        WITH latest AS (
          SELECT payload, operation,
            ROW_NUMBER() OVER (PARTITION BY local_id ORDER BY id DESC) AS rn
          FROM manufacturing_sync_events
          WHERE instance_id = ${inst.id} AND entity_type = 'account_txn'
        )
        SELECT payload FROM latest WHERE rn = 1 AND operation != 'delete'
      `),
    ]);

    const accounts = parseRows(accountRows).map(p => normaliseAccount(p));
    const txns = parseRows(txnRows);

    const balanceMap = new Map<string, number>();
    for (const t of txns) {
      const key = String(t.account_id);
      const cur = balanceMap.get(key) || 0;
      balanceMap.set(key, cur + (t.type === 'in' ? Number(t.amount || 0) : -Number(t.amount || 0)));
    }

    const result = accounts.map(a => ({
      ...a,
      current_balance: a.opening_balance + (balanceMap.get(String(a.id)) || 0),
    }));
    result.sort((a, b) => Number(a.id) - Number(b.id));

    res.json({ success: true, accounts: result });
  } catch (err: any) {
    console.error('[mfg/accounts] GET:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/** GET /api/manufacturing/accounting/ledger */
router.get('/accounting/ledger', requireManufacturingInstance, async (req: Request, res: Response) => {
  const inst   = req.mfgInstance!;
  const limit  = Math.min(Number(req.query.limit  || 50), 500);
  const offset = Number(req.query.offset || 0);
  try {
    const [accountRows, txnRows] = await Promise.all([
      prisma.$queryRaw<Array<{ payload: string }>>(Prisma.sql`
        WITH latest AS (
          SELECT payload, operation,
            ROW_NUMBER() OVER (PARTITION BY local_id ORDER BY id DESC) AS rn
          FROM manufacturing_sync_events
          WHERE instance_id = ${inst.id} AND entity_type = 'account'
        )
        SELECT payload FROM latest WHERE rn = 1 AND operation != 'delete'
      `),
      prisma.$queryRaw<Array<{ payload: string }>>(Prisma.sql`
        WITH latest AS (
          SELECT payload, operation,
            ROW_NUMBER() OVER (PARTITION BY local_id ORDER BY id DESC) AS rn
          FROM manufacturing_sync_events
          WHERE instance_id = ${inst.id} AND entity_type = 'account_txn'
        )
        SELECT payload FROM latest WHERE rn = 1 AND operation != 'delete'
      `),
    ]);

    const accountMap = new Map<string, string>();
    parseRows(accountRows).forEach(a => accountMap.set(String(a.id), a.name || 'Unknown'));

    const all = parseRows(txnRows)
      .map(t => ({
        id:           t.id,
        account_id:   t.account_id,
        account_name: accountMap.get(String(t.account_id)) || 'Unknown',
        type:         t.type,
        amount:       Number(t.amount || 0),
        category:     t.category || '',
        note:         t.note || '',
        date_created: t.date_created || null,
      }))
      .sort((a, b) => (b.date_created || '').localeCompare(a.date_created || ''));

    res.json({ success: true, entries: all.slice(offset, offset + limit), total: all.length, limit, offset });
  } catch (err: any) {
    console.error('[mfg/accounting] ledger:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/** POST /api/manufacturing/accounts */
router.post('/accounts', requireManufacturingInstance, async (req: Request, res: Response) => {
  const inst = req.mfgInstance!;
  const { name, type, opening_balance, bank_name, account_number, notes } = req.body;
  if (!name?.trim()) { res.status(400).json({ success: false, error: 'Account name is required' }); return; }
  try {
    const id = Math.floor(Date.now() / 1000);
    const ob = Number(opening_balance || 0);
    const payload = {
      id, name: name.trim(),
      type:            type || 'cash',
      opening_balance: ob,
      current_balance: ob,
      bank_name:       (bank_name      || '').trim(),
      account_number:  (account_number || '').trim(),
      notes:           (notes          || '').trim(),
      is_default:      0,
      created_at:      new Date().toISOString(),
    };
    await prisma.manufacturingSyncEvent.create({
      data: { instance_id: inst.id, entity_type: 'account', operation: 'create', local_id: id, payload: JSON.stringify(payload) },
    });
    res.status(201).json({ success: true, account: normaliseAccount(payload, ob) });
  } catch (err: any) {
    console.error('[mfg/accounts] POST:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/** PUT /api/manufacturing/accounts/:id */
router.put('/accounts/:id', requireManufacturingInstance, async (req: Request, res: Response) => {
  const inst    = req.mfgInstance!;
  const localId = Number(req.params.id);
  const { name, type, opening_balance, bank_name, account_number, notes } = req.body;
  if (!name?.trim()) { res.status(400).json({ success: false, error: 'Account name is required' }); return; }
  try {
    const payload = {
      id: localId, name: name.trim(),
      type:            type || 'cash',
      opening_balance: Number(opening_balance || 0),
      bank_name:       (bank_name      || '').trim(),
      account_number:  (account_number || '').trim(),
      notes:           (notes          || '').trim(),
      updated_at:      new Date().toISOString(),
    };
    await prisma.manufacturingSyncEvent.create({
      data: { instance_id: inst.id, entity_type: 'account', operation: 'update', local_id: localId, payload: JSON.stringify(payload) },
    });
    res.json({ success: true, account: normaliseAccount(payload) });
  } catch (err: any) {
    console.error('[mfg/accounts] PUT:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/** DELETE /api/manufacturing/accounts/:id */
router.delete('/accounts/:id', requireManufacturingInstance, async (req: Request, res: Response) => {
  const inst    = req.mfgInstance!;
  const localId = Number(req.params.id);
  try {
    await prisma.manufacturingSyncEvent.create({
      data: { instance_id: inst.id, entity_type: 'account', operation: 'delete', local_id: localId, payload: JSON.stringify({ id: localId }) },
    });
    res.json({ success: true });
  } catch (err: any) {
    console.error('[mfg/accounts] DELETE:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/** POST /api/manufacturing/accounts/transfer */
router.post('/accounts/transfer', requireManufacturingInstance, async (req: Request, res: Response) => {
  const inst = req.mfgInstance!;
  const { from_account_id, to_account_id, amount, note } = req.body;
  if (!from_account_id || !to_account_id || !amount) {
    res.status(400).json({ success: false, error: 'from_account_id, to_account_id, and amount are required' });
    return;
  }
  if (from_account_id === to_account_id) {
    res.status(400).json({ success: false, error: 'Cannot transfer to the same account' });
    return;
  }
  try {
    const now   = new Date().toISOString();
    const outId = Math.floor(Date.now() / 1000);
    const inId  = outId + 1;
    await prisma.$transaction([
      prisma.manufacturingSyncEvent.create({ data: { instance_id: inst.id, entity_type: 'account_txn', operation: 'create', local_id: outId, payload: JSON.stringify({ id: outId, account_id: Number(from_account_id), type: 'out', amount: Number(amount), category: 'transfer', note: note || '', date_created: now }) } }),
      prisma.manufacturingSyncEvent.create({ data: { instance_id: inst.id, entity_type: 'account_txn', operation: 'create', local_id: inId,  payload: JSON.stringify({ id: inId,  account_id: Number(to_account_id),   type: 'in',  amount: Number(amount), category: 'transfer', note: note || '', date_created: now }) } }),
    ]);
    res.json({ success: true });
  } catch (err: any) {
    console.error('[mfg/accounts] transfer:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
