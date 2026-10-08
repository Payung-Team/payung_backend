-- PYG-642 — [DB] ตารางทักษะ กติกาสร้างทักษะ และ Required Skills ของ booking (โครงสร้าง)
--
-- การ์ดแม่: PYG-570 (S17 · ระบบสร้าง Required Skills ของ booking จาก ADL รายข้อ, Flags และบริการ)
--
-- ⚠ เขียนมือ ห้ามรัน prisma migrate dev / db push — Sammy gate และรัน `prisma migrate deploy` เท่านั้น
--   หลัง deploy ให้เช็คว่า `prisma db pull` ไม่มี diff (schema.prisma sync ด้วยมือแล้ว)
--
-- ไฟล์นี้มีเฉพาะ "โครงสร้าง" — ไม่มีข้อมูลตั้งต้นของทักษะและกติกา และไม่ backfill booking เดิม
--   การ์ดห้ามลงทักษะ / กติกาที่ยังไม่มีในเอกสารที่อาจารย์ยืนยัน และให้แยกไฟล์เมื่อรายการยังไม่นิ่ง
--   ตอนนี้ยืนยันได้ 4 จาก 14 กติกา · รหัสทักษะในการ์ดเป็นข้อเสนอ · รหัสข้อ ADL ยังไม่ถูกกำหนดโดย S08
--
-- สิ่งที่ไฟล์นี้ทำ:
--   1) care_skills — รายการทักษะกลาง (รหัส ชื่อไทย ชื่ออังกฤษ วิชาชีพที่ทำได้)
--      locked_professions = NULL หรือ '{}' หมายถึงทักษะนี้ไม่ล็อกวิชาชีพ
--   2) care_skill_rules — กติกา "ข้อมูลใดให้ทักษะใด" จาก 3 แหล่ง: 'adl' / 'flag' / 'service'
--      score_min / score_max ใช้เฉพาะแหล่ง 'adl' (รองรับทั้งแบบเท่ากับและแบบช่วง)
--   3) bookings.required_skills TEXT[] — รหัสทักษะที่ตัดซ้ำแล้ว ไม่มี DEFAULT (booking เดิมเป็นค่าว่าง — S17-E10)
--   4) booking_required_skills — ทักษะของ booking พร้อมแหล่งที่มา · PK กันทักษะซ้ำใน booking เดียว (S17-R5)
--   5) trigger updated_at ของ care_skills / care_skill_rules + เปิด RLS ไม่มี policy ทั้ง 3 ตาราง
--
-- ★ ต่างจาก SQL ที่การ์ดเสนอ
--   • CHECK care_skills_locked_professions_check — ค่าในอาร์เรย์ต้องเป็นค่าที่ caregivers.profession รับ
--     NULL และ '{}' แปลว่าไม่ล็อกเหมือนกัน — Prisma Client อ่านทั้งสองแบบเป็น [] และเขียน NULL ลงอาร์เรย์ไม่ได้
--   • CHECK รหัสห้ามว่าง (care_skills.code, care_skill_rules.source_code)
--   • CHECK care_skill_rules_score_order_check — score_min ต้องไม่เกิน score_max
--   • FK ไป care_skills เป็น ON DELETE RESTRICT ON UPDATE CASCADE (ค่าที่ Prisma ใช้ — การ์ดไม่ได้ระบุ)
--   • trigger updated_at (ใช้ set_updated_at() ที่มีอยู่) และ RLS ไม่มี policy — แนวเดียวกับ booking_level_rules
--     การ์ดให้ยืนยันเรื่อง RLS กับ Sammy ตอน gate · ไม่กระทบ backend (ต่อด้วย role postgres)
--
-- ข้อตัดสินใจตามที่การ์ดเสนอ (ยังไม่เคาะใน story — เปลี่ยนได้ก่อน deploy):
--   • เก็บรายการทักษะ 2 ที่ (bookings.required_skills + booking_required_skills) — ฐานไม่บังคับว่าตรงกัน
--     BE ต้องเขียนพร้อมกันใน transaction เดียว (PYG-643)
--   • แหล่งที่มาละเอียดระดับแหล่ง ('adl' / 'flag' / 'service') ไม่ถึงระดับรายการ
--   • ข้อมูลล็อกวิชาชีพของทักษะอยู่ที่ care_skills.locked_professions
--     ⚠ ตอนนี้มีที่เก็บการล็อกวิชาชีพอีกที่แล้ว: care_activity_professions (ล็อกรายกิจกรรม — PYG-651 follow-up)
--   • PK ของ care_skill_rules = (source, source_code, skill_code) — ข้อ ADL เดียวให้ทักษะเดียวกันจาก 2 ช่วงคะแนนไม่ได้
--   • ฐานไม่บังคับว่ารหัสใน bookings.required_skills มีอยู่ใน care_skills (อาร์เรย์มี FK ไม่ได้)
--
-- ⚠ ข้อจำกัดของ Prisma ที่กระทบ S17-E3 (ทดสอบแล้ว): Prisma Client อ่าน required_skills ที่เป็น NULL ได้เป็น []
--   เหมือน '{}' ทุกประการ → "ยังไม่เคยคำนวณ" กับ "คำนวณแล้วไม่มีทักษะ" แยกจากค่าที่อ่านไม่ได้
--   แยกได้ด้วย filter { isEmpty: true } (ตรงเฉพาะ '{}') หรือ raw SQL หรือดู level_calculated_at ของ S16
--   (story ให้คำนวณทักษะพร้อมกับระดับในจังหวะเดียวกัน) — ต้องเคาะที่ PYG-643
--
-- idempotent: IF NOT EXISTS · DROP TRIGGER IF EXISTS ก่อนสร้างใหม่
--
-- ROLLBACK (มือ):
--   DROP TABLE IF EXISTS "booking_required_skills";
--   DROP TABLE IF EXISTS "care_skill_rules";
--   DROP TABLE IF EXISTS "care_skills";
--   ALTER TABLE "bookings" DROP COLUMN IF EXISTS "required_skills";
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261008100000_pyg570_required_skills';
--   ⚠ ถ้า PYG-643 ขึ้นแล้ว rollback = รายการทักษะของทุก booking และกติกาที่ตั้งไว้หายทั้งหมด


-- ─── 1. care_skills: รายการทักษะกลาง ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "care_skills" (
    "code"               TEXT NOT NULL,
    "name_th"            TEXT NOT NULL,
    "name_en"            TEXT NOT NULL,
    -- NULL หรือ '{}' = ไม่ล็อกวิชาชีพ · มีค่า = ผู้ดูแลต้องมี profession ตรงกับค่าใดค่าหนึ่ง
    "locked_professions" TEXT[],
    "is_active"          BOOLEAN NOT NULL DEFAULT true,
    "created_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "care_skills_pkey" PRIMARY KEY ("code"),
    CONSTRAINT "care_skills_code_not_blank"
        CHECK (btrim("code") <> ''),
    CONSTRAINT "care_skills_locked_professions_check"
        CHECK ("locked_professions" IS NULL
               OR "locked_professions" <@ ARRAY['general_caregiver', 'nurse', 'physiotherapist']::TEXT[])
);

DROP TRIGGER IF EXISTS "trg_care_skills_updated_at" ON "care_skills";
CREATE TRIGGER "trg_care_skills_updated_at"
    BEFORE UPDATE ON "care_skills"
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE "care_skills" ENABLE ROW LEVEL SECURITY;

-- ─── 2. care_skill_rules: กติกาสร้างทักษะจาก 3 แหล่ง ───────────────────────────
CREATE TABLE IF NOT EXISTS "care_skill_rules" (
    -- 'adl' = คะแนน ADL รายข้อ · 'flag' = Flags · 'service' = บริการที่จอง
    "source"      TEXT NOT NULL,
    -- รหัสข้อ ADL / รหัส Flag ตามที่ S08 กำหนด หรือรหัสบริการตามที่ S13 / S15 กำหนด
    "source_code" TEXT NOT NULL,
    -- ช่วงคะแนนที่เข้าเงื่อนไข (รวมปลายทั้งสองข้าง) — ใช้เฉพาะแหล่ง 'adl'
    "score_min"   INTEGER,
    "score_max"   INTEGER,
    "skill_code"  TEXT NOT NULL,
    "is_active"   BOOLEAN NOT NULL DEFAULT true,
    "created_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "care_skill_rules_pkey" PRIMARY KEY ("source", "source_code", "skill_code"),
    CONSTRAINT "care_skill_rules_skill_code_fkey"
        FOREIGN KEY ("skill_code") REFERENCES "care_skills" ("code") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "care_skill_rules_source_check"
        CHECK ("source" IN ('adl', 'flag', 'service')),
    CONSTRAINT "care_skill_rules_source_code_not_blank"
        CHECK (btrim("source_code") <> ''),
    CONSTRAINT "care_skill_rules_score_source_check"
        CHECK ("source" = 'adl' OR ("score_min" IS NULL AND "score_max" IS NULL)),
    CONSTRAINT "care_skill_rules_score_order_check"
        CHECK ("score_min" IS NULL OR "score_max" IS NULL OR "score_min" <= "score_max")
);

DROP TRIGGER IF EXISTS "trg_care_skill_rules_updated_at" ON "care_skill_rules";
CREATE TRIGGER "trg_care_skill_rules_updated_at"
    BEFORE UPDATE ON "care_skill_rules"
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE "care_skill_rules" ENABLE ROW LEVEL SECURITY;

-- ─── 3. bookings.required_skills ───────────────────────────────────────────────
-- NULL = ยังไม่เคยคำนวณ · '{}' = คำนวณแล้วไม่มีทักษะ (S17-E3)
ALTER TABLE "bookings"
    ADD COLUMN IF NOT EXISTS "required_skills" TEXT[];

-- ─── 4. booking_required_skills: ทักษะของ booking พร้อมแหล่งที่มา ───────────────
CREATE TABLE IF NOT EXISTS "booking_required_skills" (
    "booking_id" UUID NOT NULL,
    "skill_code" TEXT NOT NULL,
    -- แหล่งที่มาทุกแหล่งของทักษะนี้ (S17-R5)
    "sources"    TEXT[] NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "booking_required_skills_pkey" PRIMARY KEY ("booking_id", "skill_code"),
    CONSTRAINT "booking_required_skills_booking_id_fkey"
        FOREIGN KEY ("booking_id") REFERENCES "bookings" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "booking_required_skills_skill_code_fkey"
        FOREIGN KEY ("skill_code") REFERENCES "care_skills" ("code") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "booking_required_skills_sources_check"
        CHECK (cardinality("sources") >= 1
               AND "sources" <@ ARRAY['adl', 'flag', 'service']::TEXT[])
);

ALTER TABLE "booking_required_skills" ENABLE ROW LEVEL SECURITY;

-- ─── 5. post-assertion: ผิดข้อใด migration ล้มทั้งไฟล์ ─────────────────────────
DO $$
DECLARE
    cons      TEXT;
    rls_count INTEGER;
    col_ok    INTEGER;
    trg_count INTEGER;
BEGIN
    SELECT string_agg(t || ':' || k, ' ' ORDER BY t) INTO cons
      FROM (SELECT c.relname AS t, string_agg(con.contype::text || '=' || con.n, ',' ORDER BY con.contype) AS k
              FROM (SELECT conrelid, contype, count(*) AS n FROM pg_constraint
                     WHERE conrelid IN ('public.care_skills'::regclass, 'public.care_skill_rules'::regclass,
                                        'public.booking_required_skills'::regclass)
                     GROUP BY conrelid, contype) con
              JOIN pg_class c ON c.oid = con.conrelid GROUP BY c.relname) x;
    SELECT count(*) INTO rls_count FROM pg_class
     WHERE oid IN ('public.care_skills'::regclass, 'public.care_skill_rules'::regclass,
                   'public.booking_required_skills'::regclass) AND relrowsecurity;
    SELECT count(*) INTO col_ok FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'bookings' AND column_name = 'required_skills'
       AND data_type = 'ARRAY' AND udt_name = '_text' AND is_nullable = 'YES' AND column_default IS NULL;
    SELECT count(*) INTO trg_count FROM pg_trigger
     WHERE NOT tgisinternal AND tgname IN ('trg_care_skills_updated_at', 'trg_care_skill_rules_updated_at');

    IF cons <> 'booking_required_skills:c=1,f=2,p=1 care_skill_rules:c=4,f=1,p=1 care_skills:c=2,p=1'
       OR rls_count <> 3 OR col_ok <> 1 OR trg_count <> 2 THEN
        RAISE EXCEPTION 'PYG-642: ตั้งค่าไม่ครบ (constraints=[%], rls=%, required_skills_col=%, triggers=%)',
            cons, rls_count, col_ok, trg_count;
    END IF;
END $$;
