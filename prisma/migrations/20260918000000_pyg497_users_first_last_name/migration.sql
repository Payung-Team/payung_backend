-- PYG-497 — users.first_name / users.last_name (ชื่อ-นามสกุลจริงจาก Onboarding, PYG-496)
--
-- ⚠ เขียนมือ ห้ามรัน prisma migrate dev / db push — Wasan รัน `prisma migrate deploy` เท่านั้น
--
-- สิ่งที่ไฟล์นี้ทำ: เพิ่ม 2 คอลัมน์ nullable เท่านั้น
--   - ไม่ backfill: บัญชีเดิมเป็น NULL แล้วถูกพาไปหน้า Onboarding ตอน login ครั้งถัดไป (PYG-501)
--   - VARCHAR(100) ตรงกับเพดานที่ completeOnboarding validate (PYG-498)
--   - nullable + ไม่มี default → ADD COLUMN เป็น metadata-only บน Postgres 17 ไม่ rewrite ตาราง
--
-- Dry-run (2026-09-18, ก่อนรัน): users ทั้งหมด 159 แถว, role 1 = 64 แถว, คอลัมน์ยังไม่มี (0)
--   → ไม่มีแถวไหนถูกแก้ค่า ทุกแถวได้ NULL
--
-- idempotent: รันซ้ำได้ (IF NOT EXISTS)
--
-- ROLLBACK (มือ):
--   ALTER TABLE "users" DROP COLUMN IF EXISTS "first_name";
--   ALTER TABLE "users" DROP COLUMN IF EXISTS "last_name";
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20260918000000_pyg497_users_first_last_name';
--   ⚠ ถ้า PYG-498 (completeOnboarding) ขึ้นไปแล้ว ต้อง rollback โค้ดก่อน และข้อมูลที่ผู้ใช้กรอกจะหาย

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "first_name" VARCHAR(100);
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "last_name"  VARCHAR(100);
