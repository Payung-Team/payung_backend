-- Migration: เพิ่ม patient_name ใน bookings
-- IF NOT EXISTS เพื่อให้ rerun ได้ปลอดภัย (idempotent)

ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "patient_name" TEXT;
