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

/** GET /api/manufacturing/expenses */
router.get('/expenses', requireManufacturingInstance, async (req: Request, res: Response) => {
  const inst   = req.mfgInstance!;
  const search = ((req.query.search as string) || '').trim().toLowerCase();
  try {
    const rows = await prisma.$queryRaw<Array<{ payload: string }>>(Prisma.sql`
      WITH latest AS (
        SELECT payload, operation,
          ROW_NUMBER() OVER (PARTITION BY local_id ORDER BY id DESC) AS rn
        FROM manufacturing_sync_events
        WHERE instance_id = ${inst.id} AND entity_type = 'expense'
      )
      SELECT payload FROM latest WHERE rn = 1 AND operation != 'delete'
    `);

    let expenses = parseRows(rows).map(p => ({
      id:         p.id,
      title:      p.title    || '',
      category:   p.category || '',
      amount:     Number(p.amount || 0),
      date_added: p.date_added || null,
      notes:      p.notes    || '',
    }));

    if (search) {
      expenses = expenses.filter(e =>
        e.title.toLowerCase().includes(search) ||
        e.category.toLowerCase().includes(search)
      );
    }
    expenses.sort((a, b) => (b.date_added || '').localeCompare(a.date_added || ''));
    res.json({ success: true, expenses });
  } catch (err: any) {
    console.error('[mfg/expenses] GET:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/** POST /api/manufacturing/expenses */
router.post('/expenses', requireManufacturingInstance, async (req: Request, res: Response) => {
  const inst = req.mfgInstance!;
  const { title, category, amount, date_added, notes, account_id } = req.body;
  if (!title?.trim()) { res.status(400).json({ success: false, error: 'Title is required' }); return; }
  if (!amount || Number(amount) <= 0) { res.status(400).json({ success: false, error: 'Amount must be positive' }); return; }
  try {
    const id  = Math.floor(Date.now() / 1000);
    const now = new Date().toISOString();
    const expensePayload = {
      id, title: title.trim(),
      category:   (category   || '').trim(),
      amount:     Number(amount),
      date_added: date_added  || now,
      notes:      (notes      || '').trim(),
    };

    const dbOps: any[] = [
      prisma.manufacturingSyncEvent.create({
        data: { instance_id: inst.id, entity_type: 'expense', operation: 'create', local_id: id, payload: JSON.stringify(expensePayload) },
      }),
    ];

    if (account_id) {
      const txnId = id + 1;
      dbOps.push(
        prisma.manufacturingSyncEvent.create({
          data: { instance_id: inst.id, entity_type: 'account_txn', operation: 'create', local_id: txnId, payload: JSON.stringify({
            id:           txnId,
            account_id:   Number(account_id),
            type:         'out',
            amount:       Number(amount),
            category:     'expense',
            note:         `Expense: ${title.trim()}`,
            date_created: date_added || now,
          }) },
        })
      );
    }

    await prisma.$transaction(dbOps);
    res.status(201).json({ success: true, expense: expensePayload });
  } catch (err: any) {
    console.error('[mfg/expenses] POST:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/** DELETE /api/manufacturing/expenses/:id */
router.delete('/expenses/:id', requireManufacturingInstance, async (req: Request, res: Response) => {
  const inst    = req.mfgInstance!;
  const localId = Number(req.params.id);
  try {
    await prisma.manufacturingSyncEvent.create({
      data: { instance_id: inst.id, entity_type: 'expense', operation: 'delete', local_id: localId, payload: JSON.stringify({ id: localId }) },
    });
    res.json({ success: true });
  } catch (err: any) {
    console.error('[mfg/expenses] DELETE:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
