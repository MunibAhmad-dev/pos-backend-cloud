# OsaTech POS Cloud Backend

Central backend for the OsaTech Retailer POS system.  
Manages POS instances, license keys, data sync, and exposes an admin API.

---

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Create your .env file
cp .env.example .env
# Edit .env — set JWT_SECRET, ADMIN_SETUP_KEY, PORT

# 3. Create the first admin account (run once)
npm run seed:admin
# or with custom credentials:
npm run seed:admin myUsername myPassword123

# 4. Start in development mode (auto-restart on changes)
npm run dev

# 5. Build for production
npm run build && npm start
```

Server runs on **http://localhost:4000** by default.

---

## API Reference

### Auth (Admin)

| Method | Route | Description |
|--------|-------|-------------|
| POST | `/api/auth/setup` | Create first admin *(one-time, needs `x-setup-key` header)* |
| POST | `/api/auth/login` | Login `{ username, password }` → `{ token }` |
| GET  | `/api/auth/me`    | Get current admin info *(JWT required)* |

---

### POS Instance Endpoints *(API key auth)*

Every POS instance gets a unique `api_key` on registration.  
Send it as `Authorization: Bearer <api_key>` on all instance requests.

| Method | Route | Description |
|--------|-------|-------------|
| POST | `/api/instances/register` | Register / re-register a POS instance |
| GET  | `/api/instances/status`   | Get current approval & license status |
| POST | `/api/instances/heartbeat`| Update last_seen + store stats |
| POST | `/api/sync`               | Push sync queue batch (sales, customers, etc.) |

**Register body:**
```json
{
  "instance_id":   "03001234567",
  "store_name":    "Ahmed Electronics",
  "owner_name":    "Ahmed Khan",
  "owner_mobile":  "03001234567",
  "owner_email":   "ahmed@example.com",
  "store_address": "Main Market, Lahore",
  "license_key":   "OSA-MON-XXXX-YYYY"
}
```

**Sync body:**
```json
{
  "items": [
    {
      "entity_type": "sale",
      "operation":   "create",
      "local_id":    42,
      "payload":     { "id": 1, "total": 1500, "payment_method": "cash", ... }
    }
  ]
}
```

---

### Admin Dashboard Endpoints *(JWT auth)*

Send admin JWT as `Authorization: Bearer <token>`.

| Method | Route | Description |
|--------|-------|-------------|
| GET  | `/api/admin/stats` | Dashboard overview numbers |
| GET  | `/api/admin/instances` | List all POS instances |
| GET  | `/api/admin/instances/:id` | Full instance detail |
| POST | `/api/admin/instances/:id/approve` | Approve instance |
| POST | `/api/admin/instances/:id/block`   | Block instance `{ reason? }` |
| GET  | `/api/admin/instances/:id/sales`   | Paginated synced sales |
| GET  | `/api/admin/instances/:id/export`  | Full JSON export |
| GET  | `/api/admin/licenses`  | List license keys |
| POST | `/api/admin/licenses`  | Create license `{ plan, duration_days, notes? }` |
| POST | `/api/admin/licenses/:key/assign` | Assign to instance |
| DELETE | `/api/admin/licenses/:key` | Deactivate license |

---

## How the POS connects

1. In POS → **Settings** → set **Cloud Backend URL** (e.g. `http://your-server:4000`)
2. On next launch, the POS auto-registers using the owner's mobile number as `instance_id`
3. The backend creates the instance with status **`pending`**
4. Admin approves it via `POST /api/admin/instances/:id/approve`
5. Every new sale is **auto-enqueued** and synced within 30 seconds when online
6. Admin can **block** an instance — the POS detects this within 5 minutes and locks access

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `4000` | HTTP port |
| `JWT_SECRET` | *(required)* | Secret for signing admin JWTs |
| `JWT_EXPIRES_IN` | `7d` | JWT token lifetime |
| `ADMIN_SETUP_KEY` | `setup_osatech_2025` | One-time key for `/api/auth/setup` |
| `DB_PATH` | `./pos_cloud.db` | SQLite database file path |
| `ALLOWED_ORIGINS` | `http://localhost:3000` | Comma-separated CORS origins |
