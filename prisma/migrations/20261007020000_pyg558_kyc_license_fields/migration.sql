-- PYG-586 — [DB] เพิ่มเลขใบประกอบฯ และวันหมดอายุใน kyc_documents
--
-- การ์ดแม่: PYG-558 (S03 · พยาบาล/นักกายภาพฯ แนบใบประกอบฯ พร้อมวันหมดอายุใน KYC และแอดมินตรวจ)
--
-- ⚠ เขียนมือ ห้ามรัน prisma migrate dev / db push — Sammy gate และรัน `prisma migrate deploy` เท่านั้น
--   หลัง deploy ให้เช็คว่า `prisma db pull` ไม่มี diff (schema.prisma sync ด้วยมือแล้ว)
--
-- สิ่งที่ไฟล์นี้ทำ (เพิ่มคอลัมน์ nullable + constraint + index เท่านั้น ไม่แก้ค่าเดิมสักแถว):
--   1) kyc_documents.license_number TEXT       — เลขใบประกอบวิชาชีพ  (S03-AC1)
--   2) kyc_documents.expires_at     TIMESTAMPTZ — วันหมดอายุของเอกสาร  (S03-AC3)
--   3) CHECK เลขใบประกอบฯ ห้ามเป็นสตริงว่าง / มีแต่ช่องว่าง  (S03-E5)
--   4) CHECK doc_type = 'professional_license' ต้องมีทั้งเลขและวันหมดอายุ  (S03-R1 ชั้นกันที่ฐาน)
--   5) แก้ CHECK ของ review_status ให้รับค่า 'expired' เพิ่ม  (S03-AC7)
--   6) partial index บน expires_at สำหรับงานตรวจวันหมดอายุรายวัน  (S03-AC7)
--
-- ─────────────────────────────────────────────────────────────────────────────
-- ★ ผลตรวจจาก DB จริงก่อนเขียน (2026-10-07) — kyc_documents 208 แถว
--
--   doc_type      : id_card_front 98 / id_card_selfie 84 / certificate 22 / profile_photo 4
--                   → "ไม่มี CHECK" บน doc_type ค่าใหม่ 'professional_license' ใช้ได้เลย ไม่ต้องแก้อะไร
--                     (เช่นเดียวกับ 'driving_license' ของ S06 · PYG-561)
--   review_status : NULL 204 / approved 2 / pending 1 / rejected 1
--                   → "มี CHECK เดิม" kyc_documents_review_status_check (PYG-506) รับแค่
--                     pending / approved / rejected → ไฟล์นี้ DROP แล้ว ADD ใหม่ให้มี 'expired'
--   kyc_reviews   : มี document_id (FK → kyc_documents) + reason + action อยู่แล้ว (PYG-506)
--                   → เก็บเหตุผลการปฏิเสธ "รายเอกสาร" ได้ ไม่ต้องเพิ่มอะไร (ใช้อยู่จริงกับรูปโปรไฟล์)
--   ไม่มีแถว doc_type = 'professional_license' → CHECK ข้อ 4 ผ่านกับข้อมูลเดิมทุกแถว
-- ─────────────────────────────────────────────────────────────────────────────
--
-- ข้อตัดสินใจ:
--   • expires_at เป็น TIMESTAMPTZ ตามที่การ์ดเสนอ — ค่าที่เก็บ = สิ้นวันของวันหมดอายุตามเวลาไทย
--     (เช่น หมดอายุ 31 ธ.ค. 2027 → '2027-12-31 23:59:59.999+07') การแปลงเป็นหน้าที่ BE (PYG-587)
--     ถ้าทีมเคาะเป็นวันที่ล้วน (DATE) ต้องเปลี่ยนชนิด "ก่อน" deploy ไฟล์นี้
--   • expires_at ไม่ผูกกับ doc_type — S06 (ใบขับขี่) ใช้คอลัมน์เดียวกันนี้ ห้ามเพิ่มซ้ำ
--   • ฐานไม่บังคับว่าวันหมดอายุต้องเป็นอนาคต — ใบที่หมดอายุแล้วต้องยังอยู่ในตาราง (กฎอยู่ที่ BE)
--   • ไม่มี unique บน license_number — ยังไม่เคาะว่าเลขซ้ำข้ามผู้ดูแลได้หรือไม่
--   • ไม่แตะ RLS (kyc_documents ปิด RLS อยู่ — นอกขอบเขตการ์ด)
--
-- idempotent: IF NOT EXISTS / DROP CONSTRAINT IF EXISTS ก่อน ADD
--
-- ROLLBACK (มือ):
--   DROP INDEX IF EXISTS "kyc_documents_expires_at_idx";
--   ALTER TABLE "kyc_documents" DROP CONSTRAINT IF EXISTS "kyc_documents_license_fields_check";
--   ALTER TABLE "kyc_documents" DROP CONSTRAINT IF EXISTS "kyc_documents_license_number_not_blank";
--   ALTER TABLE "kyc_documents" DROP CONSTRAINT IF EXISTS "kyc_documents_review_status_check";
--   ALTER TABLE "kyc_documents" ADD CONSTRAINT "kyc_documents_review_status_check"
--       CHECK ("review_status" IS NULL OR "review_status" IN ('pending', 'approved', 'rejected'));
--   ALTER TABLE "kyc_documents" DROP COLUMN IF EXISTS "license_number", DROP COLUMN IF EXISTS "expires_at";
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261007020000_pyg558_kyc_license_fields';
--   ⚠ ถ้ามีแถว review_status = 'expired' แล้ว การ ADD CHECK เดิมกลับจะล้ม — ต้องย้ายแถวเหล่านั้นก่อน
--   ⚠ ถ้า PYG-587 ขึ้นแล้ว rollback = เลขใบประกอบฯ และวันหมดอายุที่ผู้ดูแลกรอกหายทั้งหมด


-- ─── 1. คอลัมน์ใหม่ ────────────────────────────────────────────────────────────
ALTER TABLE "kyc_documents"
    ADD COLUMN IF NOT EXISTS "license_number" TEXT,
    ADD COLUMN IF NOT EXISTS "expires_at"     TIMESTAMPTZ(6);

-- ─── 2. CHECK ของเลขใบประกอบฯ ──────────────────────────────────────────────────
ALTER TABLE "kyc_documents"
    DROP CONSTRAINT IF EXISTS "kyc_documents_license_number_not_blank";
ALTER TABLE "kyc_documents"
    ADD CONSTRAINT "kyc_documents_license_number_not_blank"
        CHECK ("license_number" IS NULL OR btrim("license_number") <> '');

ALTER TABLE "kyc_documents"
    DROP CONSTRAINT IF EXISTS "kyc_documents_license_fields_check";
ALTER TABLE "kyc_documents"
    ADD CONSTRAINT "kyc_documents_license_fields_check"
        CHECK (
            "doc_type" <> 'professional_license'
            OR ("license_number" IS NOT NULL AND "expires_at" IS NOT NULL)
        );

-- ─── 3. review_status รับ 'expired' เพิ่ม ──────────────────────────────────────
-- ค่าเดิมทุกค่ายังอยู่ครบ จึงไม่มีแถวไหนผิด CHECK ใหม่
ALTER TABLE "kyc_documents"
    DROP CONSTRAINT IF EXISTS "kyc_documents_review_status_check";
ALTER TABLE "kyc_documents"
    ADD CONSTRAINT "kyc_documents_review_status_check"
        CHECK ("review_status" IS NULL OR "review_status" IN ('pending', 'approved', 'rejected', 'expired'));

-- ─── 4. index สำหรับงานตรวจวันหมดอายุรายวัน ────────────────────────────────────
-- เอกสารส่วนใหญ่ไม่มีวันหมดอายุ → partial index พอ
CREATE INDEX IF NOT EXISTS "kyc_documents_expires_at_idx"
    ON "kyc_documents" ("expires_at")
    WHERE "expires_at" IS NOT NULL;

-- ─── 5. post-assertion ─────────────────────────────────────────────────────────
DO $$
DECLARE
    col_cnt        INTEGER;
    status_def     TEXT;
    bad_license    BIGINT;
BEGIN
    SELECT count(*) INTO col_cnt FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'kyc_documents'
       AND column_name IN ('license_number', 'expires_at') AND is_nullable = 'YES';
    SELECT pg_get_constraintdef(oid) INTO status_def FROM pg_constraint
     WHERE conrelid = 'public.kyc_documents'::regclass AND conname = 'kyc_documents_review_status_check';
    SELECT count(*) INTO bad_license FROM "kyc_documents"
     WHERE "doc_type" = 'professional_license'
       AND ("license_number" IS NULL OR "expires_at" IS NULL);

    IF col_cnt <> 2 OR status_def IS NULL OR status_def NOT LIKE '%expired%' OR bad_license <> 0 THEN
        RAISE EXCEPTION 'PYG-586: ตั้งค่าไม่ครบ (nullable_cols=%, review_status_check=%, license_missing_fields=%)',
            col_cnt, status_def, bad_license;
    END IF;
END $$;
