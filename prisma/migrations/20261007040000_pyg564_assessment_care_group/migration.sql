-- PYG-613 — [DB] เพิ่มคอลัมน์ care_group ใน care_recipient_assessments
--
-- การ์ดแม่: PYG-564 (S09 · ระบบจัดผู้สูงอายุเป็นติดสังคม ติดบ้าน หรือติดเตียงจากคะแนน ADL รวม)
--
-- ⚠ เขียนมือ ห้ามรัน prisma migrate dev / db push — Sammy gate และรัน `prisma migrate deploy` เท่านั้น
--   หลัง deploy ให้เช็คว่า `prisma db pull` ไม่มี diff (schema.prisma sync ด้วยมือแล้ว)
--   ต้องรันหลัง 20261007030000_pyg563_care_recipient_assessments (PYG-608 — ขึ้น production แล้ว 7 ต.ค. 2026)
--
-- สิ่งที่ไฟล์นี้ทำ:
--   1) care_recipient_assessments.care_group TEXT (NULL ได้)
--   2) backfill แถวที่มีอยู่ตามคะแนนรวม — ณ วันที่เขียน ตารางมี 0 แถว จึงไม่มีแถวถูกแตะ
--   3) CHECK รับเฉพาะ 3 ค่า: social (ติดสังคม) / homebound (ติดบ้าน) / bedridden (ติดเตียง)
--
-- จุดตัด (S09-R1..R3): 12–20 = social · 5–11 = homebound · 0–4 = bedridden
--   ★ ต้องตรงกับค่าคงที่ที่ BE ใช้ใน PYG-614 — ถ้าจุดตัดถูกเคาะต่างจากนี้ก่อน deploy ต้องแก้ CASE ด้านล่าง
--
-- ข้อตัดสินใจ (ตามที่การ์ดเสนอ — 3 ข้อแรกเป็นประเด็นที่การ์ดให้เคาะก่อนรัน):
--   • NULL ได้ ยังไม่ตั้ง NOT NULL — ถ้า BE ของ S08 (PYG-609) ขึ้นก่อน BE ของ S09 (PYG-614)
--     การบันทึกแบบประเมินจะยังไม่เขียนค่ากลุ่ม NOT NULL จะทำให้บันทึกล้ม
--     → ตั้ง NOT NULL ด้วย migration ถัดไปหลัง PYG-614 ขึ้นแล้ว
--   • ยังไม่มี CHECK ผูกกลุ่มกับช่วงคะแนน — จุดตัดและช่วงคะแนน 0–20 ยังรออาจารย์ยืนยัน
--     ความตรงกันของคะแนนกับกลุ่มเป็นหน้าที่ BE (คำนวณใน transaction เดียวกัน — S09-R6)
--   • คอลัมน์ธรรมดาที่ BE เขียนค่า ไม่ใช่ generated column — Prisma ที่ใช้อยู่ (6.19) ยังไม่รองรับ
--     generated column โดยตรง (ต้องประกาศเป็น field ธรรมดาและห้ามเขียน ซึ่ง type ของ client ไม่กันให้)
--   • แยกไฟล์จาก migration ของ PYG-608 — ไฟล์นั้น deploy ไปแล้ว รวมไม่ได้
--   • เก็บกลุ่มไว้กับผลประเมิน ไม่เก็บที่ care_recipients — ไม่มีแถวผลประเมิน = ไม่มีกลุ่ม (S09-AC7)
--     ไม่ backfill จาก mobility_level
--   • ไม่แตะ RLS (เปิดอยู่ ไม่มี policy ตามมติ PYG-608)
--
-- idempotent: ADD COLUMN IF NOT EXISTS · backfill เฉพาะ care_group IS NULL · DROP CONSTRAINT IF EXISTS ก่อน ADD
--
-- ROLLBACK (มือ):
--   ALTER TABLE "care_recipient_assessments" DROP CONSTRAINT IF EXISTS "care_recipient_assessments_care_group_check";
--   ALTER TABLE "care_recipient_assessments" DROP COLUMN IF EXISTS "care_group";
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261007040000_pyg564_assessment_care_group';
--   (กลุ่มคำนวณใหม่จาก adl_total_score ได้เสมอ — rollback ไม่ทำให้ข้อมูลต้นทางหาย)


-- ─── 1. คอลัมน์ ────────────────────────────────────────────────────────────────
ALTER TABLE "care_recipient_assessments"
    ADD COLUMN IF NOT EXISTS "care_group" TEXT;

-- ─── 2. backfill แถวที่มีอยู่ตามคะแนนรวม (S09-E6) ──────────────────────────────
-- adl_total_score มี CHECK 0–20 อยู่แล้ว จึงไม่มีคะแนนนอกช่วงให้ตกไปที่ ELSE โดยไม่ตั้งใจ
UPDATE "care_recipient_assessments"
   SET "care_group" = CASE
           WHEN "adl_total_score" >= 12 THEN 'social'
           WHEN "adl_total_score" >= 5  THEN 'homebound'
           ELSE 'bedridden'
       END
 WHERE "care_group" IS NULL;

-- ─── 3. CHECK ค่าที่รับ ────────────────────────────────────────────────────────
ALTER TABLE "care_recipient_assessments"
    DROP CONSTRAINT IF EXISTS "care_recipient_assessments_care_group_check";
ALTER TABLE "care_recipient_assessments"
    ADD CONSTRAINT "care_recipient_assessments_care_group_check"
        CHECK ("care_group" IN ('social', 'homebound', 'bedridden'));

-- ─── 4. post-assertion: ผิดข้อใด migration ล้มทั้งไฟล์ ─────────────────────────
DO $$
DECLARE
    null_cnt     BIGINT;
    mismatch_cnt BIGINT;
BEGIN
    SELECT count(*) INTO null_cnt FROM "care_recipient_assessments" WHERE "care_group" IS NULL;
    SELECT count(*) INTO mismatch_cnt FROM "care_recipient_assessments"
     WHERE NOT (
            ("care_group" = 'social'    AND "adl_total_score" BETWEEN 12 AND 20) OR
            ("care_group" = 'homebound' AND "adl_total_score" BETWEEN 5  AND 11) OR
            ("care_group" = 'bedridden' AND "adl_total_score" BETWEEN 0  AND 4));

    IF null_cnt <> 0 OR mismatch_cnt <> 0 THEN
        RAISE EXCEPTION 'PYG-613: backfill ไม่ครบ (care_group_null=%, group_score_mismatch=%)',
            null_cnt, mismatch_cnt;
    END IF;
END $$;
