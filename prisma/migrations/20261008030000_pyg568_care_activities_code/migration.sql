-- PYG-651 — [DB] เพิ่มคอลัมน์ code ใน care_activities (รหัสกิจกรรมตาม T-01)
--
-- การ์ดแม่: PYG-568 (S15) · ต่อจาก PYG-633 (โครงตาราง — ขึ้น production แล้ว 8 ต.ค. 2026)
--
-- ⚠ เขียนมือ ห้ามรัน prisma migrate dev / db push — Sammy gate และรัน `prisma migrate deploy` เท่านั้น
-- ต้องรันก่อน 20261008040000_pyg568_seed_care_activities (ข้อมูลเริ่มต้นใส่รหัส A01–I03 ลงคอลัมน์นี้)
--
-- สิ่งที่ไฟล์นี้ทำ:
--   1) care_activities.code TEXT (NULL ได้) — รหัสอ้างอิงที่ไม่เปลี่ยนแม้ชื่อกิจกรรมถูกแก้ถ้อยคำ
--   2) UNIQUE care_activities_code_unique — รหัสห้ามซ้ำ (Postgres ถือว่า NULL ไม่ซ้ำกัน)
--   3) CHECK care_activities_code_not_blank — ห้ามเป็นข้อความว่าง / ช่องว่างล้วน
--
-- ตรวจจาก DB จริงก่อนเขียน (2026-10-08): care_activities ยังไม่มีคอลัมน์ code · ตารางมี 0 แถว
--
-- ข้อตัดสินใจ:
--   • NULL ได้ — กิจกรรมที่แอดมินเพิ่มเองภายหลัง (PYG-634) ยังไม่มีกติกาตั้งรหัส จึงไม่บังคับ
--     ข้อมูลเริ่มต้นจาก T-01 มีรหัสครบทุกแถว
--   • ไม่บังคับรูปแบบรหัส (เช่น ตัวอักษร + เลข 2 หลัก) — รูปแบบเป็นของตาราง T-01 ไม่ใช่กติกาของระบบ
--   • booking_activities ไม่เก็บสำเนา code — สำเนา ณ ตอนจองยังเป็นชื่อ หมวด ระดับ ตาม PYG-633
--     ถ้าต้องการอ้างรหัสจาก booking ใช้ care_activity_id → care_activities.code ได้
--
-- idempotent: ADD COLUMN IF NOT EXISTS · DROP CONSTRAINT IF EXISTS ก่อน ADD
--
-- ROLLBACK (มือ):
--   ALTER TABLE "care_activities" DROP CONSTRAINT IF EXISTS "care_activities_code_not_blank";
--   ALTER TABLE "care_activities" DROP CONSTRAINT IF EXISTS "care_activities_code_unique";
--   ALTER TABLE "care_activities" DROP COLUMN IF EXISTS "code";
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261008030000_pyg568_care_activities_code';
--   ⚠ ถ้าข้อมูลเริ่มต้นขึ้นแล้ว rollback = รหัส A01–I03 หาย (ชื่อ หมวด ระดับ ยังอยู่)

ALTER TABLE "care_activities"
    ADD COLUMN IF NOT EXISTS "code" TEXT;

ALTER TABLE "care_activities"
    DROP CONSTRAINT IF EXISTS "care_activities_code_unique";
ALTER TABLE "care_activities"
    ADD CONSTRAINT "care_activities_code_unique" UNIQUE ("code");

ALTER TABLE "care_activities"
    DROP CONSTRAINT IF EXISTS "care_activities_code_not_blank";
ALTER TABLE "care_activities"
    ADD CONSTRAINT "care_activities_code_not_blank"
        CHECK ("code" IS NULL OR btrim("code") <> '');
