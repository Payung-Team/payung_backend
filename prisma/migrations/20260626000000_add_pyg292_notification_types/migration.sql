-- Migration: add_pyg292_notification_types
-- PYG-292: add 6 new values to NotificationType enum for the full booking lifecycle
-- (booking_completed, payment_held, payment_captured, refund_issued, dispute_created, dispute_resolved)
--
-- Each ADD VALUE runs in its own DO block:
--   * ADD VALUE IF NOT EXISTS  → idempotent (re-runnable)
--   * separate statements       → Postgres ไม่ให้ใช้ค่า enum ใหม่ใน transaction เดียวกับที่เพิ่ม

DO $$ BEGIN
  ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'booking_completed';
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'payment_held';
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'payment_captured';
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'refund_issued';
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'dispute_created';
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'dispute_resolved';
EXCEPTION WHEN duplicate_object THEN null;
END $$;
