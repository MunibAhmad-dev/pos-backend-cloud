-- Migration: add style column to notifications table
-- Run this on the VPS PostgreSQL database before deploying the new backend
-- Usage: psql $DATABASE_URL -f add-notification-style.sql

ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS style TEXT DEFAULT 'violet';
