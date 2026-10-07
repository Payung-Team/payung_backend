-- PYG-580 — [DB] เพิ่ม caregivers.care_level ตารางประวัติระดับ และ backfill ผู้ดูแลเดิม
--
-- การ์ดแม่: PYG-557 (S02 · แอดมินกำหนดระดับผู้ดูแล ต้น/กลาง/สูง ตอนอนุมัติ KYC)
--
-- ⚠ เขียนมือ ห้ามรัน prisma migrate dev / db push — Sammy gate และรัน `prisma migrate deploy` เท่านั้น
--   หลัง deploy ให้เช็คว่า `prisma db pull` ไม่มี diff (schema.prisma sync ด้วยมือแล้ว)
--
-- สิ่งที่ไฟล์นี้ทำ:
--   1) caregivers + care_level / care_level_set_by / care_level_set_at  (S02-AC3)
--   2) CHECK ระดับ 3 ค่า: basic (ต้น) / intermediate (กลาง) / advanced (สูง)  (S02-E9)
--   3) ตาราง caregiver_care_level_logs — ประวัติการเปลี่ยนระดับ  (S02-AC4)
--   4) backfill: ผู้ดูแลที่ KYC อนุมัติแล้ว → 'basic' + แถวประวัติ 'migration_default'  (S02-AC6)
--
-- ─────────────────────────────────────────────────────────────────────────────
-- ★ สามเรื่องที่ "ต่างจาก SQL ที่การ์ดเสนอ" — ตรวจจาก DB จริงแล้ว (2026-10-07) อ่านก่อน review
--
--   1) caregivers.id และ users.id เป็น TEXT ไม่ใช่ UUID
--      → care_level_set_by / caregiver_id / changed_by เป็น TEXT (uuid จะสร้าง FK ไม่ได้)
--
--   2) ค่า kyc_status ที่แปลว่า "อนุมัติแล้ว" คือ 'verified' ไม่ใช่ 'approved'
--      ค่าที่มีจริง: none / pending / verified / rejected (+ 'reject' หลง 1 แถว ซึ่งไม่ใช่อนุมัติ)
--      → backfill ใช้ WHERE kyc_status = 'verified'
--
--   3) UPDATE + INSERT ประวัติ ทำใน statement เดียว (CTE ... RETURNING)
--      SQL ในการ์ด INSERT ประวัติให้ "ทุกแถวที่อนุมัติแล้ว" ไม่ว่า UPDATE จะแตะแถวนั้นหรือไม่
--      → ที่นี่ประวัติเกิดเฉพาะแถวที่ถูกตั้งค่าจริง จำนวนตรงกันเสมอ และรันซ้ำไม่เกิดแถวซ้ำ
-- ─────────────────────────────────────────────────────────────────────────────
--
-- ข้อตัดสินใจอื่น:
--   • care_level ไม่มี DEFAULT และยอมให้ NULL — ผู้ดูแลใหม่ไม่ได้ระดับเองจนกว่าแอดมินกำหนด (R7)
--     กฎ "อนุมัติแล้วต้องมีระดับ" อยู่ที่ BE (PYG-581) ไม่มี CHECK ข้ามคอลัมน์
--   • care_level_set_by = NULL หมายถึง "ได้ค่าจาก migration ยังไม่ผ่านการทบทวนของแอดมิน" (R6, E3)
--     → FK ทั้ง care_level_set_by และ changed_by เป็น ON DELETE RESTRICT ไม่ใช่ SET NULL
--       ถ้า SET NULL การลบบัญชีแอดมินจะทำให้ระดับที่ทบทวนแล้วกลับไปดูเหมือน "ยังไม่ทบทวน"
--   • backfill ไม่แตะ caregivers.updated_at (ไม่ใช่การแก้ไขของผู้ใช้)
--   • เวลาใหม่ทั้งหมดเป็น TIMESTAMPTZ ตามการ์ด (คอลัมน์ kyc_* เดิมของตารางนี้เป็น timestamp ไม่มี tz)
--   • RLS: ไม่แตะ caregivers (ปิดอยู่ — นอกขอบเขต) ส่วนตารางใหม่ ENABLE RLS โดยไม่มี policy
--     = client (anon / authenticated ผ่าน PostgREST) อ่านเขียนไม่ได้เลย backend ผ่าน Prisma ใช้ได้ปกติ
--     ตามแนวตารางใหม่ช่วงหลัง (user_consents, care_logs) — ประวัตินี้ไม่มีหน้าจอไหนให้ client อ่านตรง
--
-- idempotent: IF NOT EXISTS / DROP ... IF EXISTS ก่อน ADD · backfill เลือกเฉพาะ care_level IS NULL
--
-- ROLLBACK (มือ):
--   DROP TABLE IF EXISTS "caregiver_care_level_logs";
--   ALTER TABLE "caregivers" DROP CONSTRAINT IF EXISTS "caregivers_care_level_check";
--   ALTER TABLE "caregivers" DROP CONSTRAINT IF EXISTS "caregivers_care_level_set_by_fkey";
--   ALTER TABLE "caregivers"
--       DROP COLUMN IF EXISTS "care_level",
--       DROP COLUMN IF EXISTS "care_level_set_by",
--       DROP COLUMN IF EXISTS "care_level_set_at";
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261007010000_pyg557_caregiver_care_level';
--   ⚠ ถ้า PYG-581 ขึ้นแล้วและแอดมินกำหนดระดับไปแล้ว rollback = ข้อมูลระดับและประวัติหายทั้งหมด


-- ─── 1. caregivers: ระดับ ผู้กำหนด เวลา ────────────────────────────────────────
ALTER TABLE "caregivers"
    ADD COLUMN IF NOT EXISTS "care_level"        TEXT,
    ADD COLUMN IF NOT EXISTS "care_level_set_by" TEXT,
    ADD COLUMN IF NOT EXISTS "care_level_set_at" TIMESTAMPTZ(6);

ALTER TABLE "caregivers"
    DROP CONSTRAINT IF EXISTS "caregivers_care_level_check";
ALTER TABLE "caregivers"
    ADD CONSTRAINT "caregivers_care_level_check"
        CHECK ("care_level" IS NULL OR "care_level" IN ('basic', 'intermediate', 'advanced'));

ALTER TABLE "caregivers"
    DROP CONSTRAINT IF EXISTS "caregivers_care_level_set_by_fkey";
ALTER TABLE "caregivers"
    ADD CONSTRAINT "caregivers_care_level_set_by_fkey"
        FOREIGN KEY ("care_level_set_by") REFERENCES "users"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── 2. caregiver_care_level_logs: ประวัติการเปลี่ยนระดับ ──────────────────────
CREATE TABLE IF NOT EXISTS "caregiver_care_level_logs" (
    "id"           UUID NOT NULL DEFAULT gen_random_uuid(),
    "caregiver_id" TEXT NOT NULL,
    -- NULL = กำหนดครั้งแรก (ยังไม่เคยมีระดับ)
    "old_level"    TEXT,
    "new_level"    TEXT NOT NULL,
    -- NULL = ระบบตั้งให้ (backfill ของ migration นี้) ไม่ใช่แอดมิน
    "changed_by"   TEXT,
    -- 'migration_default' = แถวจาก backfill · นอกนั้นเป็นข้อความที่แอดมินกรอก (PYG-581)
    "reason"       TEXT,
    "created_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "caregiver_care_level_logs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "caregiver_care_level_logs_caregiver_id_fkey"
        FOREIGN KEY ("caregiver_id") REFERENCES "caregivers"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "caregiver_care_level_logs_changed_by_fkey"
        FOREIGN KEY ("changed_by") REFERENCES "users"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "caregiver_care_level_logs_old_level_check"
        CHECK ("old_level" IS NULL OR "old_level" IN ('basic', 'intermediate', 'advanced')),
    CONSTRAINT "caregiver_care_level_logs_new_level_check"
        CHECK ("new_level" IN ('basic', 'intermediate', 'advanced'))
);

CREATE INDEX IF NOT EXISTS "caregiver_care_level_logs_caregiver_idx"
    ON "caregiver_care_level_logs" ("caregiver_id", "created_at" DESC);

ALTER TABLE "caregiver_care_level_logs" ENABLE ROW LEVEL SECURITY;

-- ─── 3. backfill ผู้ดูแลเดิมที่ KYC อนุมัติแล้ว (S02-AC6) ──────────────────────
WITH updated AS (
    UPDATE "caregivers"
       SET "care_level"        = 'basic',
           "care_level_set_at" = now()
     WHERE "kyc_status" = 'verified'
       AND "care_level" IS NULL
    RETURNING "id"
)
INSERT INTO "caregiver_care_level_logs" ("caregiver_id", "old_level", "new_level", "changed_by", "reason")
SELECT "id", NULL, 'basic', NULL, 'migration_default'
  FROM updated;

-- ─── 4. post-assertion: ผิดเงื่อนไขข้อใด migration ล้มทั้งไฟล์ ──────────────────
DO $$
DECLARE
    verified_no_level  INTEGER;
    unverified_level   INTEGER;
    verified_no_log    INTEGER;
    has_rls            BOOLEAN;
BEGIN
    SELECT count(*) INTO verified_no_level FROM "caregivers"
     WHERE "kyc_status" = 'verified' AND "care_level" IS NULL;
    SELECT count(*) INTO unverified_level FROM "caregivers"
     WHERE "kyc_status" <> 'verified' AND "care_level" IS NOT NULL;
    SELECT count(*) INTO verified_no_log FROM "caregivers" c
     WHERE c."care_level" IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM "caregiver_care_level_logs" l WHERE l."caregiver_id" = c."id");
    SELECT relrowsecurity INTO has_rls FROM pg_class
     WHERE oid = 'public.caregiver_care_level_logs'::regclass;

    IF verified_no_level <> 0 OR unverified_level <> 0 OR verified_no_log <> 0 OR has_rls IS NOT TRUE THEN
        RAISE EXCEPTION 'PYG-580: backfill ไม่ครบ (verified_no_level=%, unverified_level=%, level_no_log=%, rls=%)',
            verified_no_level, unverified_level, verified_no_log, has_rls;
    END IF;
END $$;
