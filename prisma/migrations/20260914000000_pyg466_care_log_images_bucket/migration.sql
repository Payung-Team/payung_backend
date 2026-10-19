-- PYG-466 — Care Log upload ผ่าน backend: bucket 'care-log-images' + care_logs.photo_bucket
--
-- ⚠ เขียนมือ ห้ามรัน prisma migrate dev / db push — Wasan รัน `prisma migrate deploy` เท่านั้น
--
-- สิ่งที่ไฟล์นี้ทำ:
--   1. สร้าง/บังคับค่า private bucket 'care-log-images' (JPEG เท่านั้น, 5 MB)
--   2. care_logs.photo_bucket — บอกว่า photo_url อยู่ bucket ไหน
--      (photo_url เก็บแค่ path แถวเก่าอยู่ job-evidence แถวใหม่อยู่ care-log-images แยกจาก path ไม่ได้)
--   3. backfill แถวเก่าที่มีรูป → 'job-evidence'
--   4. post-assertion: ค่าไม่ตรงสเปก = migration ล้ม
--
-- ★ ตั้งใจ "ไม่ห่อ EXCEPTION" (ต่างจาก PYG-352 ที่กลืน insufficient_privilege เป็น NOTICE):
--   ถ้าไม่มี schema storage หรือ role ที่รันไม่มีสิทธิ์บน storage.buckets → ต้องล้มให้เห็น
--   ไม่งั้น migrate deploy ขึ้นเขียวแต่ bucket ไม่ถูกสร้าง แล้ว endpoint อัปโหลดพังตอนใช้งานจริง
--
-- ★ ไม่สร้าง policy ใด ๆ บน storage.objects สำหรับ bucket นี้
--   เขียนด้วย service-role จาก backend เท่านั้น / อ่านผ่าน signed URL ที่ backend ออกให้
--
-- idempotent: รันซ้ำได้ทั้งไฟล์ (ON CONFLICT / IF NOT EXISTS / backfill เฉพาะแถวที่ยังเป็น NULL)
--
-- ROLLBACK (มือ):
--   ALTER TABLE "care_logs" DROP CONSTRAINT IF EXISTS "care_logs_photo_bucket_check";
--   ALTER TABLE "care_logs" DROP COLUMN IF EXISTS "photo_bucket";
--   DELETE FROM storage.buckets WHERE id = 'care-log-images'
--     AND NOT EXISTS (SELECT 1 FROM storage.objects WHERE bucket_id = 'care-log-images');
--     (ถ้า Supabase บล็อก DELETE ตรงบนตาราง storage → ล้างไฟล์แล้วลบ bucket ผ่าน Storage API)
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20260914000000_pyg466_care_log_images_bucket';
--   ⚠ ต้อง rollback โค้ดก่อน — โค้ดใหม่เขียน photo_bucket ทุก insert

-- ─── 1. Storage bucket 'care-log-images' ────────────────────────────────────────
-- DO UPDATE (ไม่ใช่ DO NOTHING): ถ้ามีคนกดสร้างใน dashboard ไว้ก่อนด้วยค่าอื่น → บังคับกลับให้ตรงสเปก
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('care-log-images', 'care-log-images', false, 5242880, ARRAY['image/jpeg'])
ON CONFLICT (id) DO UPDATE
    SET public             = EXCLUDED.public,
        file_size_limit    = EXCLUDED.file_size_limit,
        allowed_mime_types = EXCLUDED.allowed_mime_types;

-- ─── 2. care_logs.photo_bucket ──────────────────────────────────────────────────
-- NULL = ไม่มีรูป หรือแถวเก่าที่ไม่ได้ backfill → read path fallback เป็น 'job-evidence'
ALTER TABLE "care_logs" ADD COLUMN IF NOT EXISTS "photo_bucket" TEXT;

-- ─── 3. backfill แถวเก่า ─────────────────────────────────────────────────────────
-- ก่อนการ์ดนี้ รูป care log ทุกรูปมาจาก addCareLog ซึ่งรับเฉพาะ path ใน job-evidence
-- ⚠ care_logs อยู่ใน publication supabase_realtime → client ที่ subscribe อยู่ตอน deploy จะได้ UPDATE event ของแถวเหล่านี้
UPDATE "care_logs"
SET "photo_bucket" = 'job-evidence'
WHERE "photo_url" IS NOT NULL
  AND "photo_bucket" IS NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'care_logs_photo_bucket_check'
          AND conrelid = 'public.care_logs'::regclass
    ) THEN
        ALTER TABLE "care_logs" ADD CONSTRAINT "care_logs_photo_bucket_check"
            CHECK ("photo_bucket" IS NULL OR "photo_bucket" IN ('job-evidence', 'care-log-images'));
    END IF;
END $$;

-- ─── 4. post-assertion ──────────────────────────────────────────────────────────
DO $$
DECLARE
    b RECORD;
    unbackfilled BIGINT;
BEGIN
    SELECT public, file_size_limit, allowed_mime_types INTO b
    FROM storage.buckets
    WHERE id = 'care-log-images';

    IF NOT FOUND
       OR b.public
       OR b.file_size_limit IS DISTINCT FROM 5242880
       OR b.allowed_mime_types IS DISTINCT FROM ARRAY['image/jpeg'] THEN
        RAISE EXCEPTION 'PYG-466: bucket care-log-images ไม่ตรงสเปก: %', row_to_json(b);
    END IF;

    SELECT count(*) INTO unbackfilled
    FROM "care_logs"
    WHERE "photo_url" IS NOT NULL AND "photo_bucket" IS NULL;

    IF unbackfilled > 0 THEN
        RAISE EXCEPTION 'PYG-466: care_logs ยังมี % แถวที่มีรูปแต่ photo_bucket เป็น NULL', unbackfilled;
    END IF;
END $$;
