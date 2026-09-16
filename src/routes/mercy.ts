/**
 * Mercy College of Nursing — Admission Portal API
 *
 * Routes mounted at /api/mercy
 *
 * Auth:   POST /auth/register, /auth/login, /auth/admin-login
 * Student: GET/POST /student/me, /student/application
 * Admin:  GET /admin/applications, /admin/merit-list, /admin/stats
 *         PATCH /admin/applications/:id/status
 * Files:  GET /uploads/:file  (auth required)
 */

import path from 'path';
import fs from 'fs';
import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import prisma from '../db';

const router = Router();

// ─── Upload directory ─────────────────────────────────────────────────────────
const MERCY_UPLOADS_DIR = process.env.MERCY_UPLOADS_DIR
  ? path.resolve(process.env.MERCY_UPLOADS_DIR)
  : path.join(process.cwd(), 'mercy-uploads');

if (!fs.existsSync(MERCY_UPLOADS_DIR)) {
  fs.mkdirSync(MERCY_UPLOADS_DIR, { recursive: true });
}

// ─── JWT helpers ──────────────────────────────────────────────────────────────
const MERCY_SECRET = process.env.MERCY_JWT_SECRET || process.env.JWT_SECRET!;

interface MercyPayload {
  id: number;
  role: string;   // student | admin
}

function signMercyToken(payload: MercyPayload): string {
  return jwt.sign(payload, MERCY_SECRET, { expiresIn: '30d' });
}

// ─── Auth middleware ──────────────────────────────────────────────────────────
function requireMercyAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ success: false, error: 'Missing Authorization header' });
    return;
  }
  try {
    const payload = jwt.verify(header.slice(7), MERCY_SECRET) as MercyPayload;
    (req as any).mercyUser = payload;
    next();
  } catch {
    res.status(401).json({ success: false, error: 'Token expired or invalid' });
  }
}

function requireMercyAdmin(req: Request, res: Response, next: NextFunction): void {
  requireMercyAuth(req, res, () => {
    if ((req as any).mercyUser?.role !== 'admin') {
      res.status(403).json({ success: false, error: 'Admin access required' });
      return;
    }
    next();
  });
}

// ─── Multer setup ─────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, MERCY_UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${Date.now()}-${safeName}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB per file
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error(`File type not allowed: ${file.mimetype}`));
  },
});

const applicationUpload = upload.fields([
  { name: 'profilePicture', maxCount: 1 },
  { name: 'cnicFormB',      maxCount: 1 },
  { name: 'domicile',       maxCount: 1 },
  { name: 'matricDocs',     maxCount: 5 },
  { name: 'fscDocs',        maxCount: 5 },
  { name: 'kmuCat',         maxCount: 1 },
]);

// Helper: extract uploaded file path (relative filename) from multer result
function filePath(files: any, field: string): string | null {
  const f = files?.[field]?.[0];
  return f ? f.filename : null;
}
function filePaths(files: any, field: string): string[] {
  return (files?.[field] || []).map((f: Express.Multer.File) => f.filename);
}

// ─── ─── ─── ─── ─── ROUTES ─── ─── ─── ─── ────────────────────────────────

// ── Auth ─────────────────────────────────────────────────────────────────────

/**
 * POST /api/mercy/auth/register
 * Student self-registration.
 */
router.post('/auth/register', async (req: Request, res: Response) => {
  try {
    const { name, cnic, phone, email, password } = req.body as Record<string, string>;
    if (!name?.trim() || !cnic?.trim() || !phone?.trim() || !email?.trim() || !password) {
      res.status(400).json({ success: false, error: 'All fields are required: name, cnic, phone, email, password' });
      return;
    }
    if (password.length < 6) {
      res.status(400).json({ success: false, error: 'Password must be at least 6 characters' });
      return;
    }

    const existing = await prisma.mercyUser.findFirst({
      where: { OR: [{ email: email.toLowerCase().trim() }, { cnic: cnic.trim() }] },
    });
    if (existing) {
      res.status(409).json({ success: false, error: existing.email === email.toLowerCase().trim() ? 'Email already registered' : 'CNIC already registered' });
      return;
    }

    const hash = await bcrypt.hash(password, 10);
    const user = await prisma.mercyUser.create({
      data: {
        name: name.trim(),
        cnic: cnic.trim(),
        phone: phone.trim(),
        email: email.toLowerCase().trim(),
        password_hash: hash,
        role: 'student',
      },
    });

    const token = signMercyToken({ id: user.id, role: user.role });
    res.status(201).json({ success: true, token, user: { id: user.id, name: user.name, email: user.email, cnic: user.cnic, phone: user.phone, role: user.role } });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * POST /api/mercy/auth/login
 * Student login.
 */
router.post('/auth/login', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body as { email?: string; password?: string };
    if (!email || !password) {
      res.status(400).json({ success: false, error: 'email and password are required' });
      return;
    }

    const user = await prisma.mercyUser.findUnique({ where: { email: email.toLowerCase().trim() } });
    if (!user) {
      res.status(401).json({ success: false, error: 'Invalid email or password' });
      return;
    }

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      res.status(401).json({ success: false, error: 'Invalid email or password' });
      return;
    }

    const token = signMercyToken({ id: user.id, role: user.role });
    res.json({ success: true, token, user: { id: user.id, name: user.name, email: user.email, cnic: user.cnic, phone: user.phone, role: user.role } });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * POST /api/mercy/auth/admin-login
 * Admin login — uses the shared AdminUser table.
 */
router.post('/auth/admin-login', async (req: Request, res: Response) => {
  try {
    const { username, password } = req.body as { username?: string; password?: string };
    if (!username || !password) {
      res.status(400).json({ success: false, error: 'username and password are required' });
      return;
    }

    // First check dedicated mercy admin accounts
    const mercyAdmin = await prisma.mercyUser.findFirst({
      where: { email: username.toLowerCase().trim(), role: 'admin' },
    });
    if (mercyAdmin) {
      const ok = await bcrypt.compare(password, mercyAdmin.password_hash);
      if (!ok) {
        res.status(401).json({ success: false, error: 'Invalid credentials' });
        return;
      }
      const token = signMercyToken({ id: mercyAdmin.id, role: 'admin' });
      res.json({ success: true, token, user: { id: mercyAdmin.id, name: mercyAdmin.name, role: 'admin' } });
      return;
    }

    // Fall back to POS admin accounts
    const admin = await prisma.adminUser.findFirst({ where: { username: username.toLowerCase().trim() } });
    if (!admin) {
      res.status(401).json({ success: false, error: 'Invalid credentials' });
      return;
    }
    const ok = await bcrypt.compare(password, admin.password_hash);
    if (!ok) {
      res.status(401).json({ success: false, error: 'Invalid credentials' });
      return;
    }

    // Issue a mercy-scoped admin token
    const token = signMercyToken({ id: admin.id, role: 'admin' });
    res.json({ success: true, token, user: { id: admin.id, name: admin.username, role: 'admin' } });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── Student ───────────────────────────────────────────────────────────────────

/**
 * GET /api/mercy/student/me
 */
router.get('/student/me', requireMercyAuth, async (req: Request, res: Response) => {
  try {
    const { id } = (req as any).mercyUser as MercyPayload;
    const user = await prisma.mercyUser.findUnique({
      where: { id },
      select: { id: true, name: true, email: true, cnic: true, phone: true, role: true, created_at: true },
    });
    if (!user) { res.status(404).json({ success: false, error: 'User not found' }); return; }
    res.json({ success: true, data: user });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * GET /api/mercy/student/application
 */
router.get('/student/application', requireMercyAuth, async (req: Request, res: Response) => {
  try {
    const { id } = (req as any).mercyUser as MercyPayload;
    const app = await prisma.mercyApplication.findUnique({ where: { user_id: id } });
    if (!app) { res.json({ success: true, data: null }); return; }
    res.json({ success: true, data: app });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * POST /api/mercy/student/application
 * Submit (or resubmit) an application. Accepts multipart/form-data.
 * Fields: father, cnic, dob, gender, qualification, program, marksMatric, marksFsc, address
 * Files: profilePicture, cnicFormB, domicile, matricDocs (multiple), fscDocs (multiple), kmuCat
 */
router.post('/student/application', requireMercyAuth, (req: Request, res: Response, next: NextFunction) => {
  applicationUpload(req, res, (err) => {
    if (err) {
      res.status(400).json({ success: false, error: err.message });
      return;
    }
    next();
  });
}, async (req: Request, res: Response) => {
  try {
    const { id } = (req as any).mercyUser as MercyPayload;
    const body  = req.body as Record<string, string>;
    const files = req.files as any;

    // Validate required fields
    const required: Record<string, string> = {
      father:       'Father/Guardian name',
      dob:          'Date of birth',
      gender:       'Gender',
      qualification:'Previous qualification',
      program:      'Program of interest',
      marksMatric:  'Matric marks',
      address:      'Address',
    };
    for (const [key, label] of Object.entries(required)) {
      if (!body[key]?.trim()) {
        res.status(400).json({ success: false, error: `${label} is required` });
        return;
      }
    }
    if (!['BSN', 'LHV'].includes(body.program?.trim())) {
      res.status(400).json({ success: false, error: 'Program must be BSN or LHV' });
      return;
    }
    const marksMatric = parseFloat(body.marksMatric);
    if (isNaN(marksMatric) || marksMatric < 0 || marksMatric > 100) {
      res.status(400).json({ success: false, error: 'Matric marks must be a percentage between 0 and 100' });
      return;
    }
    const marksFsc = body.marksFsc ? parseFloat(body.marksFsc) : null;
    if (marksFsc !== null && (isNaN(marksFsc) || marksFsc < 0 || marksFsc > 100)) {
      res.status(400).json({ success: false, error: 'F.Sc marks must be a percentage between 0 and 100' });
      return;
    }

    // Validate required documents for new submissions
    const existing = await prisma.mercyApplication.findUnique({ where: { user_id: id } });
    if (!existing) {
      const requiredDocs: Record<string, string> = {
        profilePicture: 'Profile picture',
        cnicFormB:      'CNIC / Form-B document',
        domicile:       'Domicile certificate',
        matricDocs:     'Matric DMC / certificate',
        kmuCat:         'KMU CAT result',
      };
      for (const [field, label] of Object.entries(requiredDocs)) {
        if (!files?.[field]?.length) {
          res.status(400).json({ success: false, error: `${label} document is required` });
          return;
        }
      }
    }

    // Build document fields — keep existing if no new upload
    const profilePicture = filePath(files, 'profilePicture') ?? existing?.profile_picture ?? null;
    const cnicDoc        = filePath(files, 'cnicFormB')      ?? existing?.cnic_doc        ?? null;
    const domicileDoc    = filePath(files, 'domicile')       ?? existing?.domicile_doc    ?? null;
    const kmuCatDoc      = filePath(files, 'kmuCat')         ?? existing?.kmu_cat_doc     ?? null;

    const newMatricPaths = filePaths(files, 'matricDocs');
    const matricDocs = newMatricPaths.length
      ? JSON.stringify(newMatricPaths)
      : (existing?.matric_docs ?? null);

    const newFscPaths = filePaths(files, 'fscDocs');
    const fscDocs = newFscPaths.length
      ? JSON.stringify(newFscPaths)
      : (existing?.fsc_docs ?? null);

    const data = {
      father_name:    body.father.trim(),
      dob:            body.dob.trim(),
      gender:         body.gender.trim(),
      address:        body.address.trim(),
      qualification:  body.qualification.trim(),
      program:        body.program.trim(),
      marks_matric:   marksMatric,
      marks_fsc:      marksFsc,
      profile_picture: profilePicture,
      cnic_doc:       cnicDoc,
      domicile_doc:   domicileDoc,
      matric_docs:    matricDocs,
      fsc_docs:       fscDocs,
      kmu_cat_doc:    kmuCatDoc,
      submitted_at:   existing?.submitted_at ?? new Date(),
      status:         existing?.status ?? 'pending',
    };

    const result = existing
      ? await prisma.mercyApplication.update({ where: { user_id: id }, data })
      : await prisma.mercyApplication.create({ data: { user_id: id, ...data } });

    res.status(existing ? 200 : 201).json({ success: true, data: result });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── Files ─────────────────────────────────────────────────────────────────────

/**
 * GET /api/mercy/uploads/:file
 * Serve an uploaded file. Auth required — files are not publicly accessible.
 */
router.get('/uploads/:file', requireMercyAuth, (req: Request, res: Response) => {
  const filename = path.basename(req.params.file); // path-traversal safe
  const fileFull = path.join(MERCY_UPLOADS_DIR, filename);
  if (!fs.existsSync(fileFull)) {
    res.status(404).json({ success: false, error: 'File not found' });
    return;
  }
  res.sendFile(fileFull);
});

// ── Admin ─────────────────────────────────────────────────────────────────────

/**
 * GET /api/mercy/admin/stats
 */
router.get('/admin/stats', requireMercyAdmin, async (_req: Request, res: Response) => {
  try {
    const [total, pending, under_review, verified, rejected, allocated] = await Promise.all([
      prisma.mercyApplication.count(),
      prisma.mercyApplication.count({ where: { status: 'pending' } }),
      prisma.mercyApplication.count({ where: { status: 'under_review' } }),
      prisma.mercyApplication.count({ where: { status: 'verified' } }),
      prisma.mercyApplication.count({ where: { status: 'rejected' } }),
      prisma.mercyApplication.count({ where: { status: 'allocated' } }),
    ]);
    const totalStudents = await prisma.mercyUser.count({ where: { role: 'student' } });
    res.json({ success: true, data: { total, pending, under_review, verified, rejected, allocated, total_students: totalStudents } });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * GET /api/mercy/admin/applications
 * Query params: status?, program?, search?, limit?, offset?
 */
router.get('/admin/applications', requireMercyAdmin, async (req: Request, res: Response) => {
  try {
    const { status, program, search, limit = '50', offset = '0' } = req.query as Record<string, string>;

    const where: any = {};
    if (status && status !== 'all') where.status = status;
    if (program && program !== 'all') where.program = program;
    if (search?.trim()) {
      where.user = {
        OR: [
          { name:  { contains: search.trim(), mode: 'insensitive' } },
          { cnic:  { contains: search.trim(), mode: 'insensitive' } },
          { email: { contains: search.trim(), mode: 'insensitive' } },
        ],
      };
    }

    const [applications, total] = await Promise.all([
      prisma.mercyApplication.findMany({
        where,
        include: { user: { select: { id: true, name: true, cnic: true, phone: true, email: true } } },
        orderBy: { submitted_at: 'desc' },
        take: Math.min(Number(limit), 200),
        skip: Number(offset),
      }),
      prisma.mercyApplication.count({ where }),
    ]);

    res.json({ success: true, data: applications, total, limit: Number(limit), offset: Number(offset) });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * GET /api/mercy/admin/applications/:id
 */
router.get('/admin/applications/:id', requireMercyAdmin, async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const app = await prisma.mercyApplication.findUnique({
      where: { id },
      include: { user: { select: { id: true, name: true, cnic: true, phone: true, email: true } } },
    });
    if (!app) { res.status(404).json({ success: false, error: 'Application not found' }); return; }
    res.json({ success: true, data: app });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * PATCH /api/mercy/admin/applications/:id/status
 * Body: { status: 'pending' | 'under_review' | 'verified' | 'rejected' | 'allocated', admin_note?: string }
 */
router.patch('/admin/applications/:id/status', requireMercyAdmin, async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const { status, admin_note } = req.body as { status?: string; admin_note?: string };
    const validStatuses = ['pending', 'under_review', 'verified', 'rejected', 'allocated'];
    if (!status || !validStatuses.includes(status)) {
      res.status(400).json({ success: false, error: `status must be one of: ${validStatuses.join(', ')}` });
      return;
    }
    const updated = await prisma.mercyApplication.update({
      where: { id },
      data: { status, admin_note: admin_note?.trim() ?? undefined },
    });
    res.json({ success: true, data: updated });
  } catch (e: any) {
    if ((e as any).code === 'P2025') {
      res.status(404).json({ success: false, error: 'Application not found' });
      return;
    }
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * GET /api/mercy/admin/merit-list
 * Query: program (BSN | LHV), seats (default 30)
 * Ranks verified applicants by: FSc marks (if available) else Matric marks, descending.
 */
router.get('/admin/merit-list', requireMercyAdmin, async (req: Request, res: Response) => {
  try {
    const program = (req.query.program as string)?.trim();
    const seats   = Math.max(1, Number(req.query.seats) || 30);

    if (!program || !['BSN', 'LHV'].includes(program)) {
      res.status(400).json({ success: false, error: 'program must be BSN or LHV' });
      return;
    }

    const applicants = await prisma.mercyApplication.findMany({
      where: { program, status: 'verified' },
      include: { user: { select: { id: true, name: true, cnic: true, phone: true } } },
    });

    // Score: FSc marks (weight 60%) + Matric marks (weight 40%), or just Matric if no FSc
    const scored = applicants.map(a => {
      const matric = Number(a.marks_matric) || 0;
      const fsc    = a.marks_fsc != null ? Number(a.marks_fsc) : null;
      const score  = fsc != null ? (fsc * 0.6 + matric * 0.4) : matric;
      return { ...a, _score: score };
    });

    scored.sort((a, b) => b._score - a._score);

    const ranked = scored.map((a, i) => ({
      rank:     i + 1,
      status:   i < seats ? 'Selected' : 'Waiting',
      name:     a.user.name,
      cnic:     a.user.cnic,
      phone:    a.user.phone,
      program:  a.program,
      marks_matric: a.marks_matric,
      marks_fsc:    a.marks_fsc,
      score:    Math.round(a._score * 100) / 100,
      application_id: a.id,
      user_id:  a.user_id,
    }));

    res.json({ success: true, data: ranked, seats, total: ranked.length });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * POST /api/mercy/admin/users
 * Create a dedicated mercy admin account.
 * Body: { name, email, password }
 */
router.post('/admin/users', requireMercyAdmin, async (req: Request, res: Response) => {
  try {
    const { name, email, password } = req.body as { name?: string; email?: string; password?: string };
    if (!name?.trim() || !email?.trim() || !password) {
      res.status(400).json({ success: false, error: 'name, email, and password are required' });
      return;
    }
    if (password.length < 8) {
      res.status(400).json({ success: false, error: 'Password must be at least 8 characters' });
      return;
    }
    const existing = await prisma.mercyUser.findUnique({ where: { email: email.toLowerCase().trim() } });
    if (existing) {
      res.status(409).json({ success: false, error: 'Email already in use' });
      return;
    }
    const hash = await bcrypt.hash(password, 10);
    const user = await prisma.mercyUser.create({
      data: { name: name.trim(), email: email.toLowerCase().trim(), cnic: `ADMIN-${Date.now()}`, phone: '', password_hash: hash, role: 'admin' },
    });
    res.status(201).json({ success: true, data: { id: user.id, name: user.name, email: user.email, role: user.role } });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * POST /api/mercy/student/profile-picture
 * Standalone profile picture upload — updates the student's application record.
 * Returns the accessible URL for the uploaded file.
 * The student does NOT need to have a full application submitted yet.
 */
const profilePictureUpload = upload.single('profilePicture');

router.post('/student/profile-picture', requireMercyAuth, (req: Request, res: Response, next: NextFunction) => {
  profilePictureUpload(req, res, (err) => {
    if (err) {
      res.status(400).json({ success: false, error: err.message });
      return;
    }
    next();
  });
}, async (req: Request, res: Response) => {
  try {
    const { id } = (req as any).mercyUser as MercyPayload;

    if (!req.file) {
      res.status(400).json({ success: false, error: 'No file uploaded — field name must be "profilePicture"' });
      return;
    }

    const filename = req.file.filename;

    // Upsert the application row — create a minimal one if it doesn't exist yet
    const existing = await prisma.mercyApplication.findUnique({ where: { user_id: id } });

    // Delete old profile picture from disk if there was one
    if (existing?.profile_picture) {
      const oldPath = path.join(MERCY_UPLOADS_DIR, path.basename(existing.profile_picture));
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }

    if (existing) {
      await prisma.mercyApplication.update({ where: { user_id: id }, data: { profile_picture: filename } });
    } else {
      await prisma.mercyApplication.create({ data: { user_id: id, profile_picture: filename } });
    }

    res.json({
      success: true,
      filename,
      url: `/api/mercy/uploads/${filename}`,
    });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── Admin: Delete All Data ────────────────────────────────────────────────────

/**
 * DELETE /api/mercy/admin/data
 * Permanently deletes ALL mercy college data: every application, every student
 * account, and all uploaded files from disk. Admin accounts are preserved.
 *
 * Requires header:  x-confirm-delete: DELETE_ALL_MERCY
 *
 * This is irreversible — the frontend must show a strong confirmation dialog.
 */
router.delete('/admin/data', requireMercyAdmin, async (req: Request, res: Response) => {
  const confirm = req.headers['x-confirm-delete'];
  if (confirm !== 'DELETE_ALL_MERCY') {
    res.status(400).json({
      success: false,
      error: 'Send header x-confirm-delete: DELETE_ALL_MERCY to confirm',
    });
    return;
  }

  try {
    // Count before deletion so we can report back
    const appCount  = await prisma.mercyApplication.count();
    const userCount = await prisma.mercyUser.count({ where: { role: 'student' } });

    // 1. Delete all applications (must come first due to FK → mercy_users)
    await prisma.mercyApplication.deleteMany({});

    // 2. Delete all student accounts (preserve admin accounts)
    await prisma.mercyUser.deleteMany({ where: { role: 'student' } });

    // 3. Delete all uploaded files from disk
    let filesDeleted = 0;
    try {
      const files = fs.readdirSync(MERCY_UPLOADS_DIR);
      for (const file of files) {
        try {
          fs.unlinkSync(path.join(MERCY_UPLOADS_DIR, file));
          filesDeleted++;
        } catch { /* skip locked/missing */ }
      }
    } catch { /* directory may be empty or inaccessible */ }

    res.json({
      success: true,
      deleted: {
        applications: appCount,
        students:     userCount,
        files:        filesDeleted,
      },
    });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * GET /api/mercy/admin/data/stats
 * Preview of what DELETE /admin/data will remove — use this to show the user
 * the impact before they confirm.
 */
router.get('/admin/data/stats', requireMercyAdmin, async (_req: Request, res: Response) => {
  try {
    const [appCount, studentCount, adminCount] = await Promise.all([
      prisma.mercyApplication.count(),
      prisma.mercyUser.count({ where: { role: 'student' } }),
      prisma.mercyUser.count({ where: { role: 'admin' } }),
    ]);

    let fileCount = 0;
    try {
      fileCount = fs.readdirSync(MERCY_UPLOADS_DIR).length;
    } catch {}

    res.json({
      success: true,
      data: {
        applications: appCount,
        students:     studentCount,
        admins:       adminCount,
        uploaded_files: fileCount,
        note: 'Admin accounts are preserved when deleting all data',
      },
    });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

export default router;
