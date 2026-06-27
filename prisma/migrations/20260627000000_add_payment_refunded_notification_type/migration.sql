-- Migration: add_payment_refunded_notification_type
-- Add payment_refunded value to NotificationType enum for payment refund events

DO $$ BEGIN
  ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'payment_refunded';
EXCEPTION WHEN duplicate_object THEN null;
END $$;
