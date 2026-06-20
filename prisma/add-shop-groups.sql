-- Migration: Multi-Device Shop Groups
-- Run this on the cloud Postgres DB to enable the ShopAccount / ShopDevice feature.
-- Safe to run multiple times (IF NOT EXISTS everywhere).

CREATE TABLE IF NOT EXISTS shop_accounts (
  id            SERIAL PRIMARY KEY,
  shop_code     TEXT NOT NULL UNIQUE,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  shop_name     TEXT NOT NULL DEFAULT '',
  owner_name    TEXT NOT NULL DEFAULT '',
  owner_mobile  TEXT NOT NULL DEFAULT '',
  max_devices   INTEGER NOT NULL DEFAULT 5,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  notes         TEXT NOT NULL DEFAULT '',
  created_at    TIMESTAMP(3) NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMP(3) NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_shop_accounts_is_active ON shop_accounts (is_active);
CREATE INDEX IF NOT EXISTS idx_shop_accounts_username  ON shop_accounts (username);

CREATE TABLE IF NOT EXISTS shop_devices (
  id              SERIAL PRIMARY KEY,
  shop_account_id INTEGER NOT NULL REFERENCES shop_accounts(id) ON DELETE CASCADE,
  device_id       TEXT NOT NULL UNIQUE,
  instance_id     TEXT NOT NULL DEFAULT '',
  device_name     TEXT NOT NULL DEFAULT 'Device',
  device_type     TEXT NOT NULL DEFAULT 'desktop',
  device_role     TEXT NOT NULL DEFAULT 'sales',
  api_key         TEXT NOT NULL UNIQUE,
  last_heartbeat  TIMESTAMP(3),
  app_version     TEXT NOT NULL DEFAULT '',
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  registered_at   TIMESTAMP(3) NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_shop_devices_shop_account_id ON shop_devices (shop_account_id);
CREATE INDEX IF NOT EXISTS idx_shop_devices_api_key         ON shop_devices (api_key);
CREATE INDEX IF NOT EXISTS idx_shop_devices_instance_id     ON shop_devices (instance_id);
