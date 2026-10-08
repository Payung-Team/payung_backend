-- PYG-633 — [DB] สร้างตาราง care_activities และ booking_activities (โครงสร้าง)
--
-- การ์ดแม่: PYG-568 (S15 · แอดมินดูแลรายการกิจกรรมการดูแลพร้อมระดับ และ Elder เลือกกิจกรรมตอนจอง)
--
-- ⚠ เขียนมือ ห้ามรัน prisma migrate dev / db push — Sammy gate และรัน `prisma migrate deploy` เท่านั้น
--   หลัง deploy ให้เช็คว่า `prisma db pull` ไม่มี diff (schema.prisma sync ด้วยมือแล้ว)
--
-- ไฟล์นี้มีเฉพาะ "โครงสร้าง" — ทั้งสองตารางว่างหลังรัน
--   ข้อมูลเริ่มต้นตามตาราง T-01 อยู่ในไฟล์แยก (…_pyg568_seed_care_activities) ซึ่งยังเป็น DRAFT
--   รออาจารย์ตรวจ T-01 และ "ไม่ได้อยู่ใน PR นี้" · ระบบต้องทำงานได้เมื่อรายการว่าง (S15-E5)
--
-- สิ่งที่ไฟล์นี้ทำ:
--   1) care_activities    — รายการกิจกรรมการดูแลกลาง: ชื่อ หมวด ระดับ สถานะใช้งาน ลำดับ (S15-AC1)
--   2) booking_activities — กิจกรรมที่ booking เลือก พร้อม "สำเนา" ชื่อ หมวด ระดับ ณ ตอนจอง (S15-AC4, R6)
--   3) trigger updated_at ของ care_activities (ใช้ฟังก์ชัน set_updated_at() ที่มีอยู่แล้ว)
--   4) เปิด RLS ทั้งสองตาราง ไม่มี policy
--   ไม่แตะ booking_tasks และ bookings.tasks (S15-AC6)
--
-- ตรวจจาก DB จริงก่อนเขียน (2026-10-08): bookings.id = UUID → booking_id เป็น UUID ตามการ์ด ·
--   ยังไม่มีตารางชื่อนี้ทั้งสอง · booking_tasks 436 แถวเป็นงานพิมพ์เองทั้งหมด (is_custom) ไม่ถูกแตะ
--
-- ★ ต่างจาก SQL ที่การ์ดเสนอ 3 จุด
--   • ไม่สร้าง index booking_activities_booking_idx (booking_id)
--     — UNIQUE (booking_id, care_activity_id) ขึ้นต้นด้วย booking_id จึงใช้ค้นตาม booking ได้อยู่แล้ว
--       index แยกจะซ้ำซ้อน (เหตุผลเดียวกับที่การ์ด PYG-608 ให้ไว้เรื่อง UNIQUE ทำหน้าที่เป็น index)
--   • เพิ่ม trigger trg_care_activities_updated_at — แอดมินแก้ชื่อ / ระดับ / ปิดใช้งานแล้ว updated_at ขยับเอง
--     ไม่ต้องพึ่งว่าโค้ดทุกจุดจำตั้งค่า (แบบเดียวกับ bookings และ care_recipients)
--   • เปิด RLS โดยไม่มี policy ทั้งสองตาราง — ตามแนวตารางใหม่ช่วงหลัง
--     (role ของ client ไม่มีสิทธิ์อ่าน schema public อยู่แล้ว backend ต่อด้วย role postgres ที่ข้าม RLS ได้)
--     การ์ดให้ตกลงกับ BE ก่อนรัน — ถ้าไม่ต้องการ ตัด 2 บรรทัด ENABLE ROW LEVEL SECURITY ได้
--
-- ข้อตัดสินใจตามที่การ์ดเสนอ:
--   • care_level เป็น TEXT + CHECK ('basic' ต้น / 'intermediate' กลาง / 'advanced' สูง)
--     ชุดเดียวกับ caregivers.care_level (PYG-580)
--   • category ยังไม่มี CHECK — รายการหมวดรอ T-01 ฉบับที่อาจารย์ตรวจแล้ว
--   • ไม่มีคอลัมน์ล็อกวิชาชีพ — เป็นข้อมูลของ S17 / S18 (ดูรายการกิจกรรมที่ล็อกใน PR ของไฟล์ข้อมูลเริ่มต้น)
--   • ไม่มีคอลัมน์ผูกประเภทบริการ และไม่มีประวัติการแก้ไขของแอดมิน — ยังไม่เคาะ เพิ่มภายหลังได้
--   • care_activity_id เป็น ON DELETE RESTRICT — กิจกรรมไม่ถูกลบ ใช้ปิดใช้งานแทน (S15-R4)
--   • booking_id เป็น ON DELETE CASCADE — ลบ booking แล้วกิจกรรมที่เลือกไปด้วย
--
-- idempotent: IF NOT EXISTS · DROP TRIGGER IF EXISTS ก่อน CREATE
--
-- ROLLBACK (มือ):
--   DROP TABLE IF EXISTS "booking_activities";
--   DROP TABLE IF EXISTS "care_activities";
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261008020000_pyg568_care_activities';
--   ⚠ ถ้า PYG-634 ขึ้นแล้ว rollback = รายการกิจกรรมที่แอดมินแก้ไว้และกิจกรรมที่ booking เลือกหายทั้งหมด


-- ─── 1. care_activities: รายการกิจกรรมกลาง ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS "care_activities" (
    "id"         UUID NOT NULL DEFAULT gen_random_uuid(),
    "name_th"    TEXT NOT NULL,
    "name_en"    TEXT,
    "category"   TEXT NOT NULL,
    "care_level" TEXT NOT NULL,
    -- false = ไม่แสดงและเลือกไม่ได้ในการจองใหม่ (S15-R5) — ไม่ลบแถว
    "is_active"  BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "care_activities_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "care_activities_care_level_check"
        CHECK ("care_level" IN ('basic', 'intermediate', 'advanced')),
    -- กันชื่อซ้ำในหมวดเดียวกัน (S15-E3)
    CONSTRAINT "care_activities_category_name_unique" UNIQUE ("category", "name_th")
);

-- หน้าจอง: รายการที่เปิดใช้งาน เรียงตามหมวดและลำดับ
CREATE INDEX IF NOT EXISTS "care_activities_active_idx"
    ON "care_activities" ("is_active", "category", "sort_order");

DROP TRIGGER IF EXISTS "trg_care_activities_updated_at" ON "care_activities";
CREATE TRIGGER "trg_care_activities_updated_at"
    BEFORE UPDATE ON "care_activities"
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── 2. booking_activities: กิจกรรมที่ booking เลือก (สำเนา ณ ตอนจอง) ──────────
CREATE TABLE IF NOT EXISTS "booking_activities" (
    "id"               UUID NOT NULL DEFAULT gen_random_uuid(),
    "booking_id"       UUID NOT NULL,
    "care_activity_id" UUID NOT NULL,
    -- สำเนา ณ ตอนจอง: booking เดิมแสดงได้เหมือนเดิมแม้กิจกรรมถูกแก้หรือปิดใช้งาน (S15-R6, E1)
    "activity_name"    TEXT NOT NULL,
    "category"         TEXT NOT NULL,
    "care_level"       TEXT NOT NULL,
    "created_at"       TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "booking_activities_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "booking_activities_booking_id_fkey"
        FOREIGN KEY ("booking_id") REFERENCES "bookings"("id")
        ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "booking_activities_care_activity_id_fkey"
        FOREIGN KEY ("care_activity_id") REFERENCES "care_activities"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "booking_activities_care_level_check"
        CHECK ("care_level" IN ('basic', 'intermediate', 'advanced')),
    -- ส่งกิจกรรมเดียวกันซ้ำในการจองเดียว บันทึกครั้งเดียว (S15-E8) · ใช้ค้นตาม booking_id ด้วย
    CONSTRAINT "booking_activities_unique" UNIQUE ("booking_id", "care_activity_id")
);

-- ─── 3. RLS ────────────────────────────────────────────────────────────────────
ALTER TABLE "care_activities"    ENABLE ROW LEVEL SECURITY;
ALTER TABLE "booking_activities" ENABLE ROW LEVEL SECURITY;

-- ─── 4. post-assertion: ผิดข้อใด migration ล้มทั้งไฟล์ ─────────────────────────
DO $$
DECLARE
    ca_cons TEXT;
    ba_cons TEXT;
    rls_cnt INTEGER;
    trg_cnt INTEGER;
BEGIN
    SELECT string_agg(contype || '=' || n, ' ' ORDER BY contype) INTO ca_cons
      FROM (SELECT contype::text, count(*) AS n FROM pg_constraint
             WHERE conrelid = 'public.care_activities'::regclass GROUP BY contype) t;
    SELECT string_agg(contype || '=' || n, ' ' ORDER BY contype) INTO ba_cons
      FROM (SELECT contype::text, count(*) AS n FROM pg_constraint
             WHERE conrelid = 'public.booking_activities'::regclass GROUP BY contype) t;
    SELECT count(*) INTO rls_cnt FROM pg_class
     WHERE oid IN ('public.care_activities'::regclass, 'public.booking_activities'::regclass)
       AND relrowsecurity;
    SELECT count(*) INTO trg_cnt FROM pg_trigger
     WHERE tgrelid = 'public.care_activities'::regclass AND NOT tgisinternal;

    -- คาด: care_activities c=1 p=1 u=1 · booking_activities c=1 f=2 p=1 u=1
    IF ca_cons <> 'c=1 p=1 u=1' OR ba_cons <> 'c=1 f=2 p=1 u=1' OR rls_cnt <> 2 OR trg_cnt <> 1 THEN
        RAISE EXCEPTION 'PYG-633: ตั้งค่าไม่ครบ (care_activities=[%], booking_activities=[%], rls=%, triggers=%)',
            ca_cons, ba_cons, rls_cnt, trg_cnt;
    END IF;
END $$;
