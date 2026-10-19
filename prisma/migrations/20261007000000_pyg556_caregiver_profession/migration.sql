-- PYG-574 — [DB] เพิ่มคอลัมน์ caregivers.profession และ backfill ผู้ดูแลเดิม
--
-- การ์ดแม่: PYG-556 (S01 · ผู้ดูแลระบุวิชาชีพใน KYC และ Elder เห็นวิชาชีพในหน้า List/Profile)
--
-- ⚠ เขียนมือ ห้ามรัน prisma migrate dev / db push — Sammy gate และรัน `prisma migrate deploy` เท่านั้น
--   หลัง deploy ให้เช็คว่า `prisma db pull` ไม่มี diff (schema.prisma sync ด้วยมือแล้ว)
--
-- สิ่งที่ไฟล์นี้ทำ:
--   1) caregivers.profession text NOT NULL DEFAULT 'general_caregiver'
--      ADD COLUMN ... NOT NULL DEFAULT ค่าคงที่ = backfill แถวเดิมทุกแถวในคำสั่งเดียว
--      (Postgres 11+ ไม่ rewrite ตาราง) ไม่ต้องมี UPDATE แยก
--   2) CHECK รับเฉพาะ 3 ค่า: general_caregiver / nurse / physiotherapist  (S01-R1, E4)
--      text + CHECK ไม่ใช่ PG enum ตามแนว migration ชุด family group
--
-- ★ DEFAULT คงไว้ในคอลัมน์โดยตั้งใจ — โค้ดปัจจุบันที่ INSERT caregivers โดยไม่ส่ง profession ยังทำงานได้
--   การบังคับ "ต้องส่งวิชาชีพ" (S01-E3) อยู่ที่ชั้น API ของ PYG-575
--   จะถอด DEFAULT ออกหรือไม่ ตกลงกันหลัง PYG-575 ขึ้นแล้ว (migration แยก)
--
-- ★ ถ้าเคาะเพิ่ม "ผู้ช่วยพยาบาล" เป็นค่าที่ 4 ต้องแก้รายการใน CHECK ด้านล่าง "ก่อน" deploy ไฟล์นี้
--   ถ้าเคาะหลัง deploy แล้ว = migration ใหม่ DROP + ADD CONSTRAINT
--
-- ไม่แตะ RLS (ตาราง caregivers ปิด RLS อยู่ — นอกขอบเขตการ์ด)
--
-- idempotent: ADD COLUMN IF NOT EXISTS + DROP CONSTRAINT IF EXISTS ก่อน ADD
--
-- ROLLBACK (มือ):
--   ALTER TABLE "caregivers" DROP CONSTRAINT IF EXISTS "caregivers_profession_check";
--   ALTER TABLE "caregivers" DROP COLUMN IF EXISTS "profession";
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261007000000_pyg556_caregiver_profession';

ALTER TABLE "caregivers"
    ADD COLUMN IF NOT EXISTS "profession" TEXT NOT NULL DEFAULT 'general_caregiver';

ALTER TABLE "caregivers"
    DROP CONSTRAINT IF EXISTS "caregivers_profession_check";

ALTER TABLE "caregivers"
    ADD CONSTRAINT "caregivers_profession_check"
        CHECK ("profession" IN ('general_caregiver', 'nurse', 'physiotherapist'));
