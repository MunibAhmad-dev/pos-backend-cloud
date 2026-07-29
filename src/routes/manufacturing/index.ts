import { Router, Request, Response } from 'express';
import authRoutes from './auth';
import licenseRoutes from './license';
import syncRoutes from './sync';
import notificationsRoutes from './notifications';
import dashboardRoutes from './dashboard';
import invoicesRoutes from './invoices';
import reportsRoutes from './reports';
import sellRoutes from './sell';

// All Factory ERP (Air Cooler Manufacturing) app routes live under this folder,
// kept separate from the POS's routes/models entirely. Mounted at /api/manufacturing
// in the top-level src/index.ts.
const router = Router();

router.use('/', authRoutes);         // /register, /login
router.use('/', licenseRoutes);      // /status, /activate
router.use('/', syncRoutes);         // /sync, /cloud-counts
router.use('/', notificationsRoutes); // /notifications
router.use('/', dashboardRoutes);    // /dashboard
router.use('/', invoicesRoutes);     // /invoices
router.use('/', reportsRoutes);      // /reports
router.use('/', sellRoutes);         // /sell-items

router.get('/health', (_req: Request, res: Response) => {
  res.json({ success: true, service: 'manufacturing', timestamp: new Date().toISOString() });
});

export default router;
