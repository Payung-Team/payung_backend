-- PYG-638 — [DB] เพิ่มคอลัมน์ระดับใน bookings และตารางกติการะดับของ Flags / บริการ (โครงสร้าง)
--
-- การ์ดแม่: PYG-569 (S16 · ระบบคำนวณระดับ booking จาก ADL, Flags และบริการ แล้วใช้ค่าสูงสุด)
--
-- ⚠ เขียนมือ ห้ามรัน prisma migrate dev / db push — Sammy gate และรัน `prisma migrate deploy` เท่านั้น
--   หลัง deploy ให้เช็คว่า `prisma db pull` ไม่มี diff (schema.prisma sync ด้วยมือแล้ว)
--
-- ไฟล์นี้มีเฉพาะ "โครงสร้าง" — ไม่มีข้อมูลตั้งต้นของตารางกติกา และไม่ backfill booking เดิม
--   การ์ดห้ามลงรายการ Flag / บริการที่ยังไม่มีในเอกสารที่อาจารย์ยืนยัน และให้แยกไฟล์เมื่อรายการยังไม่นิ่ง
--   รหัส (code / variant) ของ Flag และบริการก็ยังไม่ถูกกำหนดโดย S08 / S13 / S15 — การ์ดนี้ไม่ตั้งรหัสเอง
--
-- สิ่งที่ไฟล์นี้ทำ:
--   1) bookings + required_level / level_from_adl / level_from_flags / level_from_services (TEXT, NULL ได้)
--      + level_calculated_at (TIMESTAMPTZ) — ไม่มี DEFAULT: booking เดิมทุกใบเป็นค่าว่าง (S16-E11)
--   2) CHECK 4 ตัว: คอลัมน์ระดับรับเฉพาะ 'basic' (ต้น) / 'intermediate' (กลาง) / 'advanced' (สูง) หรือค่าว่าง
--      ค่าชุดเดียวกับ caregivers.care_level (PYG-580) และ care_activities.care_level (PYG-633)
--   3) ตาราง booking_level_rules — ระดับของ Flag และบริการแต่ละรายการ (S16-AC2, AC3, AC4)
--      level = NULL หมายถึง "รายการนี้ไม่มีผลต่อระดับ" (ใช้กับกายภาพบำบัด — S16-R6)
--      ต่างจากกรณี "ไม่มีแถว" ซึ่งถือเป็นข้อมูลตั้งค่าผิด (S16-E7)
--   4) trigger updated_at ของ booking_level_rules + เปิด RLS ไม่มี policy
--
-- ★ ต่างจาก SQL ที่การ์ดเสนอ 2 จุด
--   • เพิ่ม trigger trg_booking_level_rules_updated_at (ใช้ set_updated_at() ที่มีอยู่)
--     — แก้ระดับ / ปิดใช้งานกติกาแล้ว updated_at ขยับเอง แบบเดียวกับ care_activities
--   • เปิด RLS โดยไม่มี policy — ตามแนวตารางอ้างอิงใหม่ช่วงหลัง (care_activities)
--     การ์ดให้ยืนยันกับ Sammy ตอน gate · ไม่กระทบ backend (ต่อด้วย role postgres) ถ้าไม่ต้องการตัดได้ 1 บรรทัด
--
-- ข้อตัดสินใจตามที่การ์ดเสนอ (ยังไม่เคาะใน story — เปลี่ยนได้ก่อน deploy):
--   • source รับ 'flag' และ 'service' — ถ้าเคาะว่าเกณฑ์ที่ 3 ใช้ระดับจาก care_activities โดยตรง
--     ให้ตัด 'service' ออกจาก CHECK ก่อนรัน (ดูข้อสังเกตเรื่องกายภาพบำบัดใน PR)
--   • เกณฑ์ที่ไม่มีผลเก็บเป็นค่าว่าง — ถ้าเคาะให้เก็บเป็น 'basic' โครงสร้างไม่เปลี่ยน เปลี่ยนเฉพาะที่ BE เขียน
--   • ฐานไม่บังคับว่า required_level = ค่าสูงสุดของ 3 เกณฑ์ — เป็นหน้าที่ตัวคำนวณ (PYG-639)
--   • ไม่มี bookings.required_skills — อยู่ที่ PYG-642 ของ S17
--
-- idempotent: IF NOT EXISTS · DROP CONSTRAINT / TRIGGER IF EXISTS ก่อนสร้างใหม่
--
-- ROLLBACK (มือ):
--   DROP TABLE IF EXISTS "booking_level_rules";
--   ALTER TABLE "bookings"
--       DROP CONSTRAINT IF EXISTS "bookings_required_level_check",
--       DROP CONSTRAINT IF EXISTS "bookings_level_from_adl_check",
--       DROP CONSTRAINT IF EXISTS "bookings_level_from_flags_check",
--       DROP CONSTRAINT IF EXISTS "bookings_level_from_services_check";
--   ALTER TABLE "bookings"
--       DROP COLUMN IF EXISTS "required_level",
--       DROP COLUMN IF EXISTS "level_from_adl",
--       DROP COLUMN IF EXISTS "level_from_flags",
--       DROP COLUMN IF EXISTS "level_from_services",
--       DROP COLUMN IF EXISTS "level_calculated_at";
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261008050000_pyg569_booking_required_level';
--   ⚠ ถ้า PYG-639 ขึ้นแล้ว rollback = ระดับที่คำนวณไว้ของทุก booking และกติกาที่ตั้งไว้หายทั้งหมด


-- ─── 1. bookings: ระดับสุดท้าย + ระดับรายเกณฑ์ ─────────────────────────────────
ALTER TABLE "bookings"
    ADD COLUMN IF NOT EXISTS "required_level"      TEXT,
    ADD COLUMN IF NOT EXISTS "level_from_adl"      TEXT,
    ADD COLUMN IF NOT EXISTS "level_from_flags"    TEXT,
    ADD COLUMN IF NOT EXISTS "level_from_services" TEXT,
    ADD COLUMN IF NOT EXISTS "level_calculated_at" TIMESTAMPTZ(6);

ALTER TABLE "bookings"
    DROP CONSTRAINT IF EXISTS "bookings_required_level_check",
    DROP CONSTRAINT IF EXISTS "bookings_level_from_adl_check",
    DROP CONSTRAINT IF EXISTS "bookings_level_from_flags_check",
    DROP CONSTRAINT IF EXISTS "bookings_level_from_services_check";

ALTER TABLE "bookings"
    ADD CONSTRAINT "bookings_required_level_check"
        CHECK ("required_level" IS NULL OR "required_level" IN ('basic', 'intermediate', 'advanced')),
    ADD CONSTRAINT "bookings_level_from_adl_check"
        CHECK ("level_from_adl" IS NULL OR "level_from_adl" IN ('basic', 'intermediate', 'advanced')),
    ADD CONSTRAINT "bookings_level_from_flags_check"
        CHECK ("level_from_flags" IS NULL OR "level_from_flags" IN ('basic', 'intermediate', 'advanced')),
    ADD CONSTRAINT "bookings_level_from_services_check"
        CHECK ("level_from_services" IS NULL OR "level_from_services" IN ('basic', 'intermediate', 'advanced'));

-- ─── 2. booking_level_rules: กติการะดับของ Flag / บริการ ───────────────────────
CREATE TABLE IF NOT EXISTS "booking_level_rules" (
    -- 'flag' = เกณฑ์ที่ 2 · 'service' = เกณฑ์ที่ 3
    "source"     TEXT NOT NULL,
    -- รหัส Flag ตามที่ S08 กำหนด หรือรหัสบริการตามที่ S13 / S15 กำหนด
    "code"       TEXT NOT NULL,
    -- กรณีย่อยของ Flag เดียวกัน เช่น สมองเสื่อมที่ระบุว่ารุนแรง · '' = กรณีทั่วไป
    "variant"    TEXT NOT NULL DEFAULT '',
    -- NULL = รายการนี้ไม่มีผลต่อระดับ (ไม่ใช่ "ยังไม่ตั้งค่า")
    "level"      TEXT,
    "is_active"  BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "booking_level_rules_pkey" PRIMARY KEY ("source", "code", "variant"),
    CONSTRAINT "booking_level_rules_source_check"
        CHECK ("source" IN ('flag', 'service')),
    CONSTRAINT "booking_level_rules_level_check"
        CHECK ("level" IS NULL OR "level" IN ('basic', 'intermediate', 'advanced'))
);

DROP TRIGGER IF EXISTS "trg_booking_level_rules_updated_at" ON "booking_level_rules";
CREATE TRIGGER "trg_booking_level_rules_updated_at"
    BEFORE UPDATE ON "booking_level_rules"
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE "booking_level_rules" ENABLE ROW LEVEL SECURITY;

-- ─── 3. post-assertion: ผิดข้อใด migration ล้มทั้งไฟล์ ─────────────────────────
DO $$
DECLARE
    level_checks INTEGER;
    level_cols   INTEGER;
    rules_cons   TEXT;
    has_rls      BOOLEAN;
BEGIN
    SELECT count(*) INTO level_checks FROM pg_constraint
     WHERE conrelid = 'public.bookings'::regclass AND contype = 'c'
       AND conname IN ('bookings_required_level_check', 'bookings_level_from_adl_check',
                       'bookings_level_from_flags_check', 'bookings_level_from_services_check');
    SELECT count(*) INTO level_cols FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'bookings' AND is_nullable = 'YES' AND column_default IS NULL
       AND column_name IN ('required_level', 'level_from_adl', 'level_from_flags',
                           'level_from_services', 'level_calculated_at');
    SELECT string_agg(contype || '=' || n, ' ' ORDER BY contype) INTO rules_cons
      FROM (SELECT contype::text, count(*) AS n FROM pg_constraint
             WHERE conrelid = 'public.booking_level_rules'::regclass GROUP BY contype) t;
    SELECT relrowsecurity INTO has_rls FROM pg_class WHERE oid = 'public.booking_level_rules'::regclass;

    IF level_checks <> 4 OR level_cols <> 5 OR rules_cons <> 'c=2 p=1' OR has_rls IS NOT TRUE THEN
        RAISE EXCEPTION 'PYG-638: ตั้งค่าไม่ครบ (level_checks=%, level_cols=%, rules_constraints=[%], rls=%)',
            level_checks, level_cols, rules_cons, has_rls;
    END IF;
END $$;
