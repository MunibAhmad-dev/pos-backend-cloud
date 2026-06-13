import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import prisma from '../db';
import { requireInstance } from '../middleware/instanceAuth';
import '../types';

const router = Router();

// All routes require a valid POS api_key
router.use(requireInstance);

/**
 * POST /api/branches/request
 * Submit a new branch request for the authenticated instance.
 * Body: { branch_name, phone?, address?, city?, notes? }
 */
router.post('/request', async (req: Request, res: Response) => {
  try {
    const { branch_name, phone = '', address = '', city = '', notes = '' } = req.body as {
      branch_name: string; phone?: string; address?: string; city?: string; notes?: string;
    };

    if (!branch_name?.trim()) {
      res.status(400).json({ success: false, error: 'branch_name is required' });
      return;
    }

    const instance = req.instance!;

    // Limit: 1 pending request at a time per instance
    const existing = await prisma.branchRequest.findFirst({
      where: { instance_id: instance.instance_id, status: 'pending' },
    });
    if (existing) {
      res.status(409).json({
        success: false,
        error: 'You already have a pending branch request. Wait for admin approval before submitting another.',
      });
      return;
    }

    const request = await prisma.branchRequest.create({
      data: {
        instance_id: instance.instance_id,
        branch_name: branch_name.trim(),
        phone:   phone.trim(),
        address: address.trim(),
        city:    city.trim(),
        notes:   notes.trim(),
      },
    });

    res.status(201).json({ success: true, data: request });
  } catch (e: any) {
    console.error('[branches/request]', e.message);
    res.status(500).json({ success: false, error: e.message || 'Failed to submit branch request' });
  }
});

/**
 * GET /api/branches
 * Get all branch requests for the authenticated instance.
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const instance = req.instance!;
    const requests = await prisma.branchRequest.findMany({
      where:   { instance_id: instance.instance_id },
      orderBy: { created_at: 'desc' },
    });
    res.json({ success: true, data: requests });
  } catch (e: any) {
    console.error('[branches/list]', e.message);
    res.status(500).json({ success: false, error: e.message || 'Failed to fetch branch requests' });
  }
});

export default router;
