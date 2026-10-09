-- PYG-627 — [DB] ตารางชุดบริการ และตารางจับคู่กลุ่มผู้สูงอายุกับชุดบริการ (โครงสร้าง)
--
-- การ์ดแม่: PYG-567 (S14 · หน้าจองแนะนำชุดบริการตามกลุ่มของผู้สูงอายุ และญาติยังเลือกนอกชุดได้)
-- Sammy อนุมัติขอบเขต 9 ต.ค. 2026
--
-- ⚠ เขียนมือ ห้ามรัน prisma migrate dev / db push — Sammy gate และรัน `prisma migrate deploy` เท่านั้น
--   หลัง deploy ให้เช็คว่า `prisma db pull` ไม่มี diff (schema.prisma sync ด้วยมือแล้ว)
--
-- ไฟล์นี้มีเฉพาะ "โครงสร้าง" — ไม่มีข้อมูลตั้งต้น: เนื้อหาชุดบริการยังไม่ได้อนุมัติ รอจาก Sammy
--   ตารางว่างต้องไม่ทำให้ระบบพัง (S14-E8) จึงปล่อยโครงสร้างได้ก่อนข้อมูล
--
-- สิ่งที่ไฟล์นี้ทำ:
--   1) service_packages — ชุดบริการ (รหัส ชื่อ คำอธิบาย ลำดับ)
--   2) service_package_items — บริการในชุด · UNIQUE (package_id, service_type)
--   3) care_group_service_packages — กลุ่มผู้สูงอายุใดเห็นชุดใด · UNIQUE (care_group, package_id)
--      + index (care_group, is_active, sort_order) สำหรับค้นตามกลุ่ม
--   4) trigger updated_at ทั้ง 3 ตาราง (ใช้ set_updated_at() ที่มีอยู่) + เปิด RLS ไม่มี policy
--
-- ★ ต่างจาก SQL ที่การ์ดเสนอ (ข้อ a, b Sammy กำหนด 9 ต.ค. 2026)
--   a) CHECK ของ care_group ใช้ 'social' / 'homebound' / 'bedridden' — ค่าชุดเดียวกับ
--      care_recipient_assessments.care_group (PYG-613) ไม่ใช่ social_bound / home_bound / bed_bound
--   b) เพิ่ม CHECK service_package_items.service_type ∈ general_care / bedridden_care / physiotherapy /
--      medication / companion — ตรงกับ enum booking_service_type และ service_price_catalog
--   c) service_package_items มีคอลัมน์ updated_at เพิ่ม (การ์ดไม่มี) — ต้องมีเพื่อให้ trigger updated_at
--      ทำงานได้ครบทุกตารางตามที่กำหนด
--   d) FK เป็น ON DELETE CASCADE ON UPDATE CASCADE (การ์ดระบุแค่ ON DELETE — ON UPDATE ใช้ค่าที่ Prisma คาด)
--
-- ฐานไม่บังคับ:
--   • service_type เป็น TEXT + CHECK ไม่ได้ผูก FK กับ service_price_catalog — เพิ่มประเภทบริการใหม่ต้องแก้ CHECK นี้ด้วย
--   • ปิดใช้งานด้วย is_active = false ไม่ลบแถว (ลบชุด = บริการในชุดและการจับคู่หายตาม CASCADE)
--
-- idempotent: IF NOT EXISTS · DROP TRIGGER IF EXISTS ก่อนสร้างใหม่
--
-- ROLLBACK (มือ):
--   DROP TABLE IF EXISTS "care_group_service_packages";
--   DROP TABLE IF EXISTS "service_package_items";
--   DROP TABLE IF EXISTS "service_packages";
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261009020000_pyg567_service_packages';


-- ─── 1. service_packages: ชุดบริการ ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "service_packages" (
    "id"             UUID NOT NULL DEFAULT gen_random_uuid(),
    "code"           TEXT NOT NULL,
    "name_th"        TEXT NOT NULL,
    "name_en"        TEXT NOT NULL,
    "description_th" TEXT,
    "description_en" TEXT,
    "is_active"      BOOLEAN NOT NULL DEFAULT true,
    "sort_order"     INTEGER NOT NULL DEFAULT 0,
    "created_at"     TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at"     TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "service_packages_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "service_packages_code_key" UNIQUE ("code")
);

DROP TRIGGER IF EXISTS "trg_service_packages_updated_at" ON "service_packages";
CREATE TRIGGER "trg_service_packages_updated_at"
    BEFORE UPDATE ON "service_packages"
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE "service_packages" ENABLE ROW LEVEL SECURITY;

-- ─── 2. service_package_items: บริการในชุด ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS "service_package_items" (
    "id"           UUID NOT NULL DEFAULT gen_random_uuid(),
    "package_id"   UUID NOT NULL,
    -- ประเภทบริการแบบเดียวกับ bookings.service_type / service_price_catalog.service_type
    "service_type" TEXT NOT NULL,
    "sort_order"   INTEGER NOT NULL DEFAULT 0,
    "created_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "service_package_items_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "service_package_items_package_id_fkey"
        FOREIGN KEY ("package_id") REFERENCES "service_packages" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "service_package_items_unique" UNIQUE ("package_id", "service_type"),
    CONSTRAINT "service_package_items_service_type_check"
        CHECK ("service_type" IN ('general_care', 'bedridden_care', 'physiotherapy', 'medication', 'companion'))
);

DROP TRIGGER IF EXISTS "trg_service_package_items_updated_at" ON "service_package_items";
CREATE TRIGGER "trg_service_package_items_updated_at"
    BEFORE UPDATE ON "service_package_items"
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE "service_package_items" ENABLE ROW LEVEL SECURITY;

-- ─── 3. care_group_service_packages: กลุ่มผู้สูงอายุ ↔ ชุดบริการ ───────────────
CREATE TABLE IF NOT EXISTS "care_group_service_packages" (
    "id"         UUID NOT NULL DEFAULT gen_random_uuid(),
    -- 'social' ติดสังคม · 'homebound' ติดบ้าน · 'bedridden' ติดเตียง
    "care_group" TEXT NOT NULL,
    "package_id" UUID NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active"  BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "care_group_service_packages_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "care_group_service_packages_package_id_fkey"
        FOREIGN KEY ("package_id") REFERENCES "service_packages" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "care_group_service_packages_unique" UNIQUE ("care_group", "package_id"),
    CONSTRAINT "care_group_service_packages_group_check"
        CHECK ("care_group" IN ('social', 'homebound', 'bedridden'))
);

CREATE INDEX IF NOT EXISTS "care_group_service_packages_group_idx"
    ON "care_group_service_packages" ("care_group", "is_active", "sort_order");

DROP TRIGGER IF EXISTS "trg_care_group_service_packages_updated_at" ON "care_group_service_packages";
CREATE TRIGGER "trg_care_group_service_packages_updated_at"
    BEFORE UPDATE ON "care_group_service_packages"
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE "care_group_service_packages" ENABLE ROW LEVEL SECURITY;

-- ─── 4. post-assertion: ผิดข้อใด migration ล้มทั้งไฟล์ ─────────────────────────
DO $$
DECLARE
    cons      TEXT;
    rls_count INTEGER;
    trg_count INTEGER;
    idx_count INTEGER;
BEGIN
    SELECT string_agg(t || ':' || k, ' ' ORDER BY t) INTO cons
      FROM (SELECT c.relname AS t, string_agg(con.contype::text || '=' || con.n, ',' ORDER BY con.contype) AS k
              FROM (SELECT conrelid, contype, count(*) AS n FROM pg_constraint
                     WHERE conrelid IN ('public.service_packages'::regclass, 'public.service_package_items'::regclass,
                                        'public.care_group_service_packages'::regclass)
                     GROUP BY conrelid, contype) con
              JOIN pg_class c ON c.oid = con.conrelid GROUP BY c.relname) x;
    SELECT count(*) INTO rls_count FROM pg_class
     WHERE oid IN ('public.service_packages'::regclass, 'public.service_package_items'::regclass,
                   'public.care_group_service_packages'::regclass) AND relrowsecurity;
    SELECT count(*) INTO trg_count FROM pg_trigger
     WHERE NOT tgisinternal AND tgname IN ('trg_service_packages_updated_at', 'trg_service_package_items_updated_at',
                                           'trg_care_group_service_packages_updated_at');
    SELECT count(*) INTO idx_count FROM pg_indexes
     WHERE schemaname = 'public' AND indexname = 'care_group_service_packages_group_idx';

    IF cons <> 'care_group_service_packages:c=1,f=1,p=1,u=1 service_package_items:c=1,f=1,p=1,u=1 service_packages:p=1,u=1'
       OR rls_count <> 3 OR trg_count <> 3 OR idx_count <> 1 THEN
        RAISE EXCEPTION 'PYG-627: ตั้งค่าไม่ครบ (constraints=[%], rls=%, triggers=%, index=%)',
            cons, rls_count, trg_count, idx_count;
    END IF;
END $$;
