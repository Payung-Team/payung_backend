-- PYG-618 — [DB] เพิ่มคอลัมน์โรคติดเชื้อใน care_recipients และการรับทราบของผู้ดูแลใน bookings
--
-- การ์ดแม่: PYG-565 (S10 · ญาติแจ้งโรคติดเชื้อ และผู้ดูแลเห็นพร้อมกดรับทราบก่อนรับงาน)
--
-- ⚠ เขียนมือ ห้ามรัน prisma migrate dev / db push — Sammy gate และรัน `prisma migrate deploy` เท่านั้น
--   หลัง deploy ให้เช็คว่า `prisma db pull` ไม่มี diff (schema.prisma sync ด้วยมือแล้ว)
--
-- สิ่งที่ไฟล์นี้ทำ (เพิ่มคอลัมน์ nullable เท่านั้น ไม่มี backfill ไม่แก้ค่าเดิมสักแถว):
--   care_recipients
--     • has_infectious_disease        BOOLEAN      — NULL = ยังไม่ได้ระบุ · false = ญาติระบุว่าไม่มี · true = ญาติระบุว่ามี
--     • infectious_disease_updated_at TIMESTAMPTZ  — เวลาที่ญาติระบุ / แก้ไขล่าสุด
--   bookings
--     • infection_ack_at TIMESTAMPTZ  — เวลาที่ผู้ดูแลรับทราบ (S10-R6)
--     • infection_ack_by TEXT → caregivers(id)  — ผู้ดูแลคนที่รับทราบ  ★ เพิ่มจากที่การ์ดเสนอ (ดูด้านล่าง)
--
-- ─────────────────────────────────────────────────────────────────────────────
-- ★ ผลตรวจจาก DB และโค้ดจริงก่อนเขียน (2026-10-08) — สองเรื่องที่การ์ดให้ตรวจ
--
--   1) สิทธิ์การอ่าน (ข้อมูลสุขภาพ)
--      care_recipients และ bookings เปิด RLS ทั้งคู่ (4 และ 5 policy)
--      role ของ client — anon / authenticated / service_role — "ไม่มีสิทธิ์ SELECT ตารางทั้งสอง
--      และไม่มี USAGE บน schema public เลย" → อ่านผ่าน PostgREST ไม่ได้ไม่ว่า policy เขียนไว้อย่างไร
--      role เดียวที่อ่านได้คือ postgres ที่ backend ใช้ · frontend ไม่มีโค้ดอ่านตารางตรง
--      → ไม่ต้องแยกข้อมูลนี้ไปตารางใหม่เพื่อคุมสิทธิ์ การจำกัดผู้เห็น (S10-R7) เป็นหน้าที่ BE (PYG-619)
--
--   2) โครงสร้างคำขอรับงาน — "ไม่ตรงกับสมมติฐานของการ์ดเต็มที่"
--      ณ เวลาใดเวลาหนึ่ง booking มีผู้ดูแลได้คนเดียว (bookings.caregiver_id) ✔
--      แต่ booking ใบเดียวผ่านผู้ดูแลได้หลายคน "ตามลำดับ":
--        declineBooking / cancelAcceptance → status 'rejected'
--        recoverBooking → status 'unmatched' + caregiver_id = NULL แล้วญาติเลือกผู้ดูแลคนใหม่
--      ถ้าเก็บแค่ infection_ack_at ตามที่การ์ดเสนอ เวลารับทราบของผู้ดูแลคนเก่าจะค้างอยู่กับ booking
--      และผู้ดูแลคนใหม่จะดูเหมือน "รับทราบแล้ว" ทั้งที่ไม่เคยเห็น
--      → เก็บ infection_ack_by คู่กัน: การรับทราบนับเฉพาะเมื่อ infection_ack_by = caregiver_id ปัจจุบัน
--        (กันได้ที่ระดับข้อมูล ไม่ต้องพึ่งว่าทุกทางที่เปลี่ยนผู้ดูแลจำล้างค่าได้ครบ)
--      CHECK bookings_infection_ack_pair_check บังคับว่ามี "โดยใคร" ต้องมี "เมื่อใด" (ดูข้อ 3)
-- ─────────────────────────────────────────────────────────────────────────────
--
-- ข้อตัดสินใจอื่น (ตามที่การ์ดเสนอ):
--   • has_infectious_disease ไม่มี DEFAULT โดยตั้งใจ — ผู้สูงอายุเดิมทุกคนเป็น "ยังไม่ได้ระบุ" (NULL)
--     ถ้าใส่ DEFAULT false จะถูกอ่านว่า "ไม่มี" ทั้งที่ไม่มีใครระบุ (S10-E1) · ไม่เดาจาก medical_conditions
--   • ยังไม่เพิ่ม infectious_disease_note — รอเคาะว่าจะให้ระบุชื่อโรคหรือไม่ (เพิ่มภายหลังได้ด้วย migration ใหม่)
--   • ไม่คัดลอกข้อมูลโรคติดเชื้อลง bookings — bookings เก็บเฉพาะ "รับทราบเมื่อใด โดยใคร" ไม่เก็บว่ามีหรือไม่มี
--   • เทียบ infection_ack_at กับ infectious_disease_updated_at เพื่อรู้ว่ารับทราบค่าล่าสุดหรือค่าเก่า (S10-E2, E3)
--   • FK infection_ack_by → caregivers เป็น ON DELETE SET NULL เหมือน bookings.caregiver_id เดิม
--     และ CHECK คู่เขียนให้ทนต่อกรณีนั้น (ดูข้อ 3)
--   • ไม่บันทึกเป็นเหตุการณ์ใน job_events — ตารางนั้นมี CHECK รับแค่ 'check_in' / 'check_out'
--     และออกแบบไว้เก็บหลักฐานตำแหน่ง / รูป ไม่ตรงกับการรับทราบก่อนรับงาน
--   • ไม่แตะ RLS
--
-- idempotent: ADD COLUMN IF NOT EXISTS · DROP CONSTRAINT IF EXISTS ก่อน ADD
--
-- ROLLBACK (มือ):
--   ALTER TABLE "bookings" DROP CONSTRAINT IF EXISTS "bookings_infection_ack_pair_check";
--   ALTER TABLE "bookings" DROP CONSTRAINT IF EXISTS "bookings_infection_ack_by_fkey";
--   ALTER TABLE "bookings" DROP COLUMN IF EXISTS "infection_ack_at", DROP COLUMN IF EXISTS "infection_ack_by";
--   ALTER TABLE "care_recipients"
--       DROP COLUMN IF EXISTS "has_infectious_disease",
--       DROP COLUMN IF EXISTS "infectious_disease_updated_at";
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261008010000_pyg565_infectious_disease_disclosure';
--   ⚠ ถ้า PYG-619 ขึ้นแล้ว rollback = ข้อมูลที่ญาติแจ้งและหลักฐานการรับทราบของผู้ดูแลหายทั้งหมด


-- ─── 1. care_recipients: ข้อมูลที่ญาติแจ้ง ─────────────────────────────────────
ALTER TABLE "care_recipients"
    ADD COLUMN IF NOT EXISTS "has_infectious_disease"        BOOLEAN,
    ADD COLUMN IF NOT EXISTS "infectious_disease_updated_at" TIMESTAMPTZ(6);

-- ─── 2. bookings: การรับทราบของผู้ดูแล ─────────────────────────────────────────
ALTER TABLE "bookings"
    ADD COLUMN IF NOT EXISTS "infection_ack_at" TIMESTAMPTZ(6),
    ADD COLUMN IF NOT EXISTS "infection_ack_by" TEXT;

ALTER TABLE "bookings"
    DROP CONSTRAINT IF EXISTS "bookings_infection_ack_by_fkey";
ALTER TABLE "bookings"
    ADD CONSTRAINT "bookings_infection_ack_by_fkey"
        FOREIGN KEY ("infection_ack_by") REFERENCES "caregivers"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── 3. รับทราบ "โดยใคร" ต้องมี "เมื่อใด" เสมอ ─────────────────────────────────
-- ไม่บังคับทิศกลับ (มีเวลาแต่ไม่มีคน) เพราะ FK เป็น ON DELETE SET NULL:
-- ถ้าแถว caregivers ถูกลบ infection_ack_by จะกลายเป็น NULL โดยเวลายังอยู่ ซึ่งต้องไม่ทำให้การลบล้ม
-- แถวแบบนั้นไม่นับเป็นการรับทราบของใครอยู่แล้ว (ack_by ไม่ตรงกับ caregiver_id)
ALTER TABLE "bookings"
    DROP CONSTRAINT IF EXISTS "bookings_infection_ack_pair_check";
ALTER TABLE "bookings"
    ADD CONSTRAINT "bookings_infection_ack_pair_check"
        CHECK ("infection_ack_by" IS NULL OR "infection_ack_at" IS NOT NULL);

-- ─── 4. post-assertion: ค่าเดิมต้องไม่ถูกแตะ ───────────────────────────────────
DO $$
DECLARE
    disclosed_cnt BIGINT;
    acked_cnt     BIGINT;
    col_cnt       INTEGER;
BEGIN
    SELECT count(*) INTO disclosed_cnt FROM "care_recipients"
     WHERE "has_infectious_disease" IS NOT NULL OR "infectious_disease_updated_at" IS NOT NULL;
    SELECT count(*) INTO acked_cnt FROM "bookings"
     WHERE "infection_ack_at" IS NOT NULL OR "infection_ack_by" IS NOT NULL;
    SELECT count(*) INTO col_cnt FROM information_schema.columns
     WHERE table_schema = 'public' AND is_nullable = 'YES' AND column_default IS NULL
       AND ((table_name = 'care_recipients' AND column_name IN ('has_infectious_disease', 'infectious_disease_updated_at'))
         OR (table_name = 'bookings' AND column_name IN ('infection_ack_at', 'infection_ack_by')));

    -- disclosed_cnt / acked_cnt เป็น 0 เสมอตอนรันครั้งแรก · รันซ้ำหลังมีข้อมูลจริงให้ผ่านได้ จึงเช็คเฉพาะโครงสร้าง
    IF col_cnt <> 4 THEN
        RAISE EXCEPTION 'PYG-618: คอลัมน์ไม่ครบหรือไม่เป็น nullable/ไม่มี default (พบ % จาก 4)', col_cnt;
    END IF;
    RAISE NOTICE 'PYG-618: care_recipients ที่ระบุแล้ว = %, bookings ที่รับทราบแล้ว = %', disclosed_cnt, acked_cnt;
END $$;
