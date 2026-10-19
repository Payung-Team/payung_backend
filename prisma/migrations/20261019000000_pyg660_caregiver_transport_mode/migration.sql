-- PYG-660 (S06 · PYG-561): caregivers.transport_mode — คำตอบ "ขับรถรับส่งผู้รับการดูแลเองหรือไม่"
--
-- ⚠ เขียนมือ ห้ามรัน prisma migrate dev / db push — Sammy gate และรัน `prisma migrate deploy` เท่านั้น
--
-- มติ 19 ต.ค. 2026 (คอมเมนต์ใน PYG-561):
--   'self_drive' = ขับเอง (ต้องมีใบขับขี่ · PYG-597) · 'hired_ride' = ใช้รถรับจ้าง · 'none' = ไม่รับส่ง
--   NULL = ยังไม่เคยตอบ (ผู้ดูแลเดิมทั้งหมด · E11) — ไม่ backfill และห้ามตีความว่า 'none' (E10)
--
-- เพิ่มคอลัมน์ nullable ไม่มี default → Postgres แก้แค่ catalog ไม่ rewrite ตาราง
-- CHECK เช็คแถวเดิมทั้งหมด แต่ทุกแถวเป็น NULL จึงผ่าน
-- โค้ดเดิมไม่อ่านคอลัมน์นี้ → ขึ้นก่อน BE (PYG-661) ได้
--
-- ROLLBACK (มือ):
--   ALTER TABLE "caregivers" DROP CONSTRAINT IF EXISTS "caregivers_transport_mode_check";
--   ALTER TABLE "caregivers" DROP COLUMN IF EXISTS "transport_mode";
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261019000000_pyg660_caregiver_transport_mode';

ALTER TABLE "caregivers" ADD COLUMN IF NOT EXISTS "transport_mode" TEXT;

ALTER TABLE "caregivers" DROP CONSTRAINT IF EXISTS "caregivers_transport_mode_check";
ALTER TABLE "caregivers" ADD CONSTRAINT "caregivers_transport_mode_check"
  CHECK ("transport_mode" IS NULL OR "transport_mode" IN ('self_drive', 'hired_ride', 'none'));
