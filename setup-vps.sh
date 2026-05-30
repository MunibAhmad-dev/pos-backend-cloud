#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# OsaTech POS Backend — VPS First-Time Setup
# Tested on Ubuntu 22.04 / Debian 12 (Hostinger KVM VPS)
#
# Usage:
#   chmod +x setup-vps.sh
#   ./setup-vps.sh
#
# What it does:
#   1. Installs Node.js 20 LTS
#   2. Installs PostgreSQL 16
#   3. Creates the database user + database
#   4. Installs PM2
#   5. Installs Nginx
#   6. Writes a .env file (you fill in secrets)
#   7. Installs npm dependencies, runs Prisma push, seeds admin
#   8. Builds TypeScript
#   9. Starts the app with PM2
#  10. Saves PM2 startup so the app survives reboots
# ─────────────────────────────────────────────────────────────────────────────

set -e   # exit on first error

# ── Config — change these before running ─────────────────────────────────────
APP_DIR="/home/$(whoami)/pos-backend-cloud"   # where you uploaded the code
DB_NAME="pos_cloud_db"
DB_USER="osatech_user"
DB_PASS="$(openssl rand -hex 20)"             # auto-generates a strong password
JWT_SECRET="$(openssl rand -hex 48)"
ADMIN_SETUP_KEY="setup_osatech_2025"
PORT=4000

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║   OsaTech POS — VPS Setup                ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# ── 1. System update ──────────────────────────────────────────────────────────
echo "▶ Updating system packages..."
sudo apt-get update -y && sudo apt-get upgrade -y

# ── 2. Node.js 20 via NodeSource ──────────────────────────────────────────────
echo "▶ Installing Node.js 20..."
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v && npm -v

# ── 3. PostgreSQL 16 ──────────────────────────────────────────────────────────
echo "▶ Installing PostgreSQL..."
sudo apt-get install -y postgresql postgresql-contrib
sudo systemctl enable postgresql
sudo systemctl start postgresql
echo "   PostgreSQL installed: $(psql --version)"

# ── 4. Create DB user + database ─────────────────────────────────────────────
echo "▶ Creating database user and database..."
sudo -u postgres psql <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${DB_USER}') THEN
    CREATE USER ${DB_USER} WITH PASSWORD '${DB_PASS}';
  END IF;
END
\$\$;

CREATE DATABASE ${DB_NAME} OWNER ${DB_USER};
GRANT ALL PRIVILEGES ON DATABASE ${DB_NAME} TO ${DB_USER};
SQL
echo "   DB user:     ${DB_USER}"
echo "   DB name:     ${DB_NAME}"

# ── 5. PM2 ────────────────────────────────────────────────────────────────────
echo "▶ Installing PM2..."
sudo npm install -g pm2
pm2 -v

# ── 6. Nginx ──────────────────────────────────────────────────────────────────
echo "▶ Installing Nginx..."
sudo apt-get install -y nginx
sudo systemctl enable nginx
sudo systemctl start nginx

# ── 7. Write .env ─────────────────────────────────────────────────────────────
echo "▶ Writing .env..."
cd "${APP_DIR}"
cat > .env <<ENV
PORT=${PORT}
NODE_ENV=production

JWT_SECRET=${JWT_SECRET}
JWT_EXPIRES_IN=7d
ADMIN_SETUP_KEY=${ADMIN_SETUP_KEY}

DATABASE_URL="postgresql://${DB_USER}:${DB_PASS}@localhost:5432/${DB_NAME}"

# Add frontend origins here (comma-separated, no trailing slash)
ALLOWED_ORIGINS=*
ENV
echo "   .env written."

# ── 8. Install deps, Prisma, build ────────────────────────────────────────────
echo "▶ Installing npm dependencies..."
npm ci --production=false

echo "▶ Generating Prisma client..."
npm run db:generate

echo "▶ Pushing schema to database..."
npm run db:push

echo "▶ Seeding admin user (admin / osatech@2025)..."
npm run seed:admin || echo "   Seed skipped (admin may already exist)"

echo "▶ Building TypeScript..."
npm run build

mkdir -p logs

# ── 9. Start with PM2 ─────────────────────────────────────────────────────────
echo "▶ Starting app with PM2..."
pm2 start ecosystem.config.js --env production
pm2 save

# ── 10. Configure PM2 to start on boot ────────────────────────────────────────
echo "▶ Setting PM2 startup hook..."
pm2 startup | tail -1 | bash || true
pm2 save

# ── 11. Basic Nginx config ────────────────────────────────────────────────────
echo "▶ Writing Nginx site config..."
SERVER_IP=$(curl -s ifconfig.me)
sudo tee /etc/nginx/sites-available/pos-backend > /dev/null <<NGINX
server {
    listen 80;
    server_name ${SERVER_IP};
    client_max_body_size 4m;

    location / {
        proxy_pass         http://127.0.0.1:${PORT};
        proxy_http_version 1.1;
        proxy_set_header   Host              \$host;
        proxy_set_header   X-Real-IP         \$remote_addr;
        proxy_set_header   X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
        proxy_read_timeout 60s;
    }
}
NGINX

sudo ln -sf /etc/nginx/sites-available/pos-backend /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║   ✅  Setup complete!                                         ║"
echo "╠══════════════════════════════════════════════════════════════╣"
echo "║   Backend URL :  http://${SERVER_IP}                         "
echo "║   Health check:  http://${SERVER_IP}/health                  "
echo "║                                                               ║"
echo "║   DB name     :  ${DB_NAME}                                  "
echo "║   DB user     :  ${DB_USER}                                  "
echo "║   DB password :  ${DB_PASS}  ← save this!                   "
echo "║   JWT secret  :  (in .env)                                   "
echo "║                                                               ║"
echo "║   Admin login :  POST /api/auth/setup  (first time only)     ║"
echo "║   Setup key   :  ${ADMIN_SETUP_KEY}                          "
echo "║                                                               ║"
echo "║   Useful commands:                                            ║"
echo "║   pm2 logs pos-backend  — live app logs                      ║"
echo "║   pm2 status            — process status                     ║"
echo "║   npm run deploy        — rebuild + hot-restart              ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""
echo "⚠  Save the DB_PASS above — it's only shown once."
echo "   It's also stored in ${APP_DIR}/.env"
echo ""
