-- Migration: เพิ่ม notes และ day_of_contact columns ใน bookings
-- IF NOT EXISTS ทุกที่ เพื่อให้ rerun ได้ปลอดภัย (idempotent)

ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "notes"                       TEXT;
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "day_of_contact_name"         TEXT;
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "day_of_contact_phone"        TEXT;
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "day_of_contact_relationship" TEXT;
