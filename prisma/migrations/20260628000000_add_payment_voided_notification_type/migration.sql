-- Migration: add_payment_voided_notification_type
-- PYG-286: เพิ่ม 'payment_voided' ใน NotificationType enum
-- ใช้สำหรับแจ้ง patient ว่า hold ถูก void เมื่อ cancelBooking (auto-void)
--
-- ADD VALUE IF NOT EXISTS → idempotent (re-runnable), เหมือน pattern ที่ PYG-292 ใช้
-- DO block แยก + EXCEPTION duplicate_object null → ปลอดภัยถ้า value มีอยู่แล้ว

DO $$ BEGIN
  ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'payment_voided';
EXCEPTION WHEN duplicate_object THEN null;
END $$;
