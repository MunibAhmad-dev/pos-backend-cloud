import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

// Route modules
import authRoutes      from './routes/auth';
import instanceRoutes  from './routes/instances';
import syncRoutes      from './routes/sync';
import adminRoutes     from './routes/admin';
import businessRoutes from './routes/businesses';   // ← add this

// Prisma client is lazily initialized on first use — no explicit bootstrap needed.

const app  = express();
const PORT = Number(process.env.PORT) || 5000;

// ─── Security ────────────────────────────────────────────────────────────────
app.use(helmet());

// CORS — allow the admin dashboard origin(s) plus the Electron app (file://)
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:3001,http://localhost:5173,https://munibahmad-dev.github.io')
  .split(',')
  .map(o => o.trim());
app.use(cors({
  origin: (origin, cb) => {
    // Allow Electron (no origin header) and listed web origins
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error(`CORS: ${origin} is not allowed`));
  },
  credentials: true,
}));

// ─── Body parsing ────────────────────────────────────────────────────────────
app.use(express.json({ limit: '2mb' }));

// ─── Rate limiting ────────────────────────────────────────────────────────────
// Strict limiter for auth routes
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,   // 15 minutes
  max: 20,
  message: { success: false, error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Loose limiter for POS sync (high frequency, multiple shops)
const syncLimiter = rateLimit({
  windowMs: 60 * 1000,         // 1 minute
  max: 300,
  message: { success: false, error: 'Sync rate limit exceeded.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ─── Routes ──────────────────────────────────────────────────────────────────
app.use('/api/auth',       authLimiter,  authRoutes);
app.use('/api/instances',  syncLimiter,  instanceRoutes);
app.use('/api/sync',       syncLimiter,  syncRoutes);
app.use('/api/admin',                   adminRoutes);
//besiness

// inside the routes section:
app.use('/api', businessRoutes);                    // ← add this
// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'pos-backend-cloud', timestamp: new Date().toISOString() });
});

// ─── 404 fallback ─────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ success: false, error: 'Route not found' });
});

// ─── Error handler ────────────────────────────────────────────────────────────
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[ERROR]', err.message);
  res.status(500).json({ success: false, error: err.message || 'Internal server error' });
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n┌─────────────────────────────────────────────┐`);
  console.log(`│   OsaTech POS Cloud Backend                 │`);
  console.log(`│   Running on http://localhost:${PORT}           │`);
  console.log(`├─────────────────────────────────────────────┤`);
  console.log(`│  POST  /api/auth/setup       (first admin)  │`);
  console.log(`│  POST  /api/auth/login       (admin login)  │`);
  console.log(`│  POST  /api/instances/register              │`);
  console.log(`│  GET   /api/instances/status  [api_key]     │`);
  console.log(`│  POST  /api/instances/heartbeat [api_key]   │`);
  console.log(`│  POST  /api/sync              [api_key]     │`);
  console.log(`│  GET   /api/admin/*           [jwt]         │`);
  console.log(`└─────────────────────────────────────────────┘\n`);
});

export default app;
