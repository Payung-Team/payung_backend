-- PYG-506 — สถานะรีวิว "รายเอกสาร" + ผูก kyc_reviews กับเอกสาร (ฐานของ PYG-488 รูปโปรไฟล์ผู้ดูแล)
--
-- ⚠ เขียนมือ ห้ามรัน prisma migrate dev / db push — Wasan รัน `prisma migrate deploy` เท่านั้น
--
-- ทำไมต้องมี:
--   โครงเดิมรีวิว "ทั้งก้อน KYC" เท่านั้น — kyc_documents ไม่มีสถานะ และ kyc_reviews ผูกแค่ caregiver_id
--   รูปโปรไฟล์ (PYG-488) ต้องรีวิวรายใบ และเหตุผลที่ปฏิเสธรูปต้องไม่ปนกับเหตุผลที่ปฏิเสธ KYC
--
-- สิ่งที่ไฟล์นี้ทำ (เพิ่มคอลัมน์ nullable + index เท่านั้น ไม่แก้ค่าเดิมสักแถว):
--   1. kyc_documents.review_status  — 'pending' | 'approved' | 'rejected' (NULL = ไม่ได้รีวิวรายใบ)
--   2. kyc_documents.reviewed_at    — เวลาที่แอดมินตัดสินเอกสารใบนั้น
--   3. kyc_reviews.document_id      — FK → kyc_documents (NULL = รีวิว KYC ทั้งก้อนแบบเดิม)
--   4. index สำหรับคิวแอดมิน (review_status) และการไล่ประวัติรีวิวของเอกสาร (document_id)
--
-- ★ FK เป็น ON DELETE SET NULL ไม่ใช่ CASCADE — แถว audit ใน kyc_reviews ต้องอยู่รอด
--   แม้เอกสารจะถูกลบ (เหตุผลที่แอดมินปฏิเสธคือหลักฐาน ไม่ใช่ metadata ของไฟล์)
--
-- ★ review_status เป็น TEXT + CHECK ไม่ใช่ enum — kyc_status / doc_type ในโปรเจกต์นี้ก็เป็น TEXT
--   (enum ใหม่ = ต้อง migration ทุกครั้งที่เพิ่มค่า และ Prisma ต้อง regenerate ทั้ง client)
--
-- Dry-run (prod, 2026-09-20 ก่อนรัน):
--   kyc_documents 184 แถว — id_card_front 88 / id_card_selfie 74 / certificate 22 → ทุกแถวได้ review_status = NULL
--   kyc_reviews 73 แถว → ทุกแถวได้ document_id = NULL
--   caregivers 73 คน (verified 45) — ไม่มีใครมี users.avatar_url เลย (0) → **ไม่ต้องล้างค่าเดิม**
--   คอลัมน์ทั้ง 3 ยังไม่มีในฐาน (0)
--
-- idempotent: รันซ้ำได้ (IF NOT EXISTS / DO $$ กันซ้ำของ constraint)
--
-- ROLLBACK (มือ):
--   ALTER TABLE "kyc_reviews"   DROP CONSTRAINT IF EXISTS "kyc_reviews_document_id_fkey";
--   DROP INDEX IF EXISTS "idx_kyc_reviews_document";
--   ALTER TABLE "kyc_reviews"   DROP COLUMN IF EXISTS "document_id";
--   DROP INDEX IF EXISTS "idx_kyc_documents_review_status";
--   ALTER TABLE "kyc_documents" DROP CONSTRAINT IF EXISTS "kyc_documents_review_status_check";
--   ALTER TABLE "kyc_documents" DROP COLUMN IF EXISTS "reviewed_at";
--   ALTER TABLE "kyc_documents" DROP COLUMN IF EXISTS "review_status";
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20260920000000_pyg506_kyc_document_review_status';
--   ⚠ ถ้า PYG-507/508 ขึ้นไปแล้ว ต้อง rollback โค้ดก่อน — รูปที่รออนุมัติจะหายสถานะ

-- ─── 1. kyc_documents: สถานะรีวิวรายใบ ─────────────────────────────────────────
ALTER TABLE "kyc_documents" ADD COLUMN IF NOT EXISTS "review_status" TEXT;
ALTER TABLE "kyc_documents" ADD COLUMN IF NOT EXISTS "reviewed_at"   TIMESTAMPTZ;

DO $$
BEGIN
    ALTER TABLE "kyc_documents"
        ADD CONSTRAINT "kyc_documents_review_status_check"
        CHECK ("review_status" IS NULL OR "review_status" IN ('pending', 'approved', 'rejected'));
EXCEPTION
    WHEN duplicate_object THEN NULL;  -- รันซ้ำ
END $$;

-- คิวแอดมิน "รูปโปรไฟล์รออนุมัติ" อ่านเฉพาะแถวที่มีสถานะ → partial index พอ
CREATE INDEX IF NOT EXISTS "idx_kyc_documents_review_status"
    ON "kyc_documents" ("review_status")
    WHERE "review_status" IS NOT NULL;

-- ─── 2. kyc_reviews: รีวิวใบนี้ตัดสินเอกสารใบไหน ───────────────────────────────
ALTER TABLE "kyc_reviews" ADD COLUMN IF NOT EXISTS "document_id" TEXT;

DO $$
BEGIN
    ALTER TABLE "kyc_reviews"
        ADD CONSTRAINT "kyc_reviews_document_id_fkey"
        FOREIGN KEY ("document_id") REFERENCES "kyc_documents"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;  -- รันซ้ำ
END $$;

CREATE INDEX IF NOT EXISTS "idx_kyc_reviews_document"
    ON "kyc_reviews" ("document_id")
    WHERE "document_id" IS NOT NULL;

-- ─── 3. post-assertion: ค่าเดิมต้องไม่ถูกแตะ ───────────────────────────────────
DO $$
DECLARE
    dirty_docs    BIGINT;
    dirty_reviews BIGINT;
BEGIN
    SELECT count(*) INTO dirty_docs    FROM "kyc_documents" WHERE "review_status" IS NOT NULL;
    SELECT count(*) INTO dirty_reviews FROM "kyc_reviews"   WHERE "document_id"   IS NOT NULL;
    IF dirty_docs > 0 OR dirty_reviews > 0 THEN
        RAISE EXCEPTION 'PYG-506: migration ต้องไม่ตั้งค่าให้แถวเดิม (docs=%, reviews=%)', dirty_docs, dirty_reviews;
    END IF;
END $$;
