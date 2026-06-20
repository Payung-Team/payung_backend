-- Migration: แปลง enum columns ใน bookings เป็น TEXT
-- Prisma schema ประกาศ service_type, time_slot, status เป็น String (ไม่ใช่ @db.Enum)
-- ดังนั้น database ควรเป็น TEXT เพื่อให้ตรงกับ Prisma client
-- ::TEXT cast รักษาค่าเดิมทั้งหมดไว้ ไม่มี data loss

-- 1. ลบ CHECK constraint ที่ใช้ enum type ก่อน (จะสร้างใหม่ด้วย text literals)
ALTER TABLE "bookings" DROP CONSTRAINT IF EXISTS "chk_bedridden_no_accompany";

-- 2. service_type: booking_service_type → TEXT
ALTER TABLE "bookings" ALTER COLUMN "service_type" TYPE TEXT USING "service_type"::TEXT;

-- 3. time_slot: time_slot → TEXT  (แก้ปัญหา 'night' ไม่อยู่ใน enum)
ALTER TABLE "bookings" ALTER COLUMN "time_slot" TYPE TEXT USING "time_slot"::TEXT;

-- 4. status: booking_status → TEXT
ALTER TABLE "bookings" ALTER COLUMN "status" TYPE TEXT USING "status"::TEXT;
-- reset default เพื่อให้แน่ใจว่าใช้ text literal แทน enum literal
ALTER TABLE "bookings" ALTER COLUMN "status" SET DEFAULT 'unmatched';

-- 5. สร้าง CHECK constraint ใหม่โดยใช้ text literals แทน enum literals
ALTER TABLE "bookings" ADD CONSTRAINT "chk_bedridden_no_accompany"
  CHECK (NOT (service_type = 'bedridden_care' AND 'accompany_outside' = ANY (service_locations)));
