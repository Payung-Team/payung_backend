-- PYG-298: Average rating recalculation — DB trigger + denormalized columns
--
-- เป้าหมาย: เก็บ average_rating / review_count ของ caregiver ไว้เป็นคอลัมน์ (denormalized)
-- แล้วให้ DB trigger คอยอัปเดตให้อัตโนมัติทุกครั้งที่ตาราง reviews เปลี่ยน
-- → search + public profile อ่านค่าจากคอลัมน์ได้เลย ไม่ต้อง JOIN reviews + GROUP BY สดทุก request
--
-- หมายเหตุเรื่องตาราง: ticket เขียนว่า "UPDATE users" แต่จริง ๆ reviews.caregiver_id
-- เป็น FK ไปที่ caregivers.id (ไม่ใช่ users.id) — ทั้ง search.service และ caregiver-public
-- ก็ key ด้วย caregivers.id อยู่แล้ว เลยเก็บ aggregate ไว้บน "caregivers" ให้ตรงกับโมเดลจริง

-- ─── 1) เพิ่มคอลัมน์ aggregate ────────────────────────────────────────────────
--   average_rating  → ค่าเฉลี่ย rating (ปัด 2 ตำแหน่ง) ; NULL = ยังไม่มีรีวิวที่มองเห็นได้
--   review_count    → จำนวนรีวิวที่ is_visible = true ; default 0 เพื่อให้แถวเดิมมีค่าเริ่มต้นทันที
ALTER TABLE "caregivers"
  ADD COLUMN IF NOT EXISTS "average_rating" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "review_count"   INTEGER NOT NULL DEFAULT 0;

-- ─── 2) Backfill ค่าเดิม ──────────────────────────────────────────────────────
-- คำนวณจากรีวิวที่มีอยู่แล้ว (เฉพาะ is_visible = true) ครั้งเดียวตอน migrate
-- เพื่อให้ caregiver ที่มีรีวิวอยู่แล้วมีค่าถูกต้องทันที — ไม่ต้องรอให้มีรีวิวใหม่มาทริกเกอร์
-- (สูตรเหมือน trigger ด้านล่างเป๊ะ ๆ: ROUND(AVG,2) + COUNT)
UPDATE "caregivers" c
SET
  "average_rating" = agg.avg_rating,
  "review_count"   = agg.cnt
FROM (
  SELECT
    "caregiver_id",
    ROUND(AVG("rating")::numeric, 2)::float8 AS avg_rating,
    COUNT(*)::int                            AS cnt
  FROM "reviews"
  WHERE "is_visible" = true
  GROUP BY "caregiver_id"
) AS agg
WHERE c."id" = agg."caregiver_id";

-- ─── 3) ฟังก์ชันคำนวณใหม่ ─────────────────────────────────────────────────────
-- recalculate_caregiver_rating() — คำนวณ average_rating + review_count ใหม่
-- สำหรับ caregiver ของแถวรีวิวที่เพิ่งเปลี่ยน แล้วเขียนกลับไปที่ตาราง caregivers
--
--  - INSERT / UPDATE → ใช้ NEW.caregiver_id
--  - DELETE          → ใช้ OLD.caregiver_id (NEW เป็น NULL ตอน DELETE)
--  - ถ้าไม่เหลือรีวิวที่มองเห็นได้เลย: AVG จะเป็น NULL และ COUNT จะเป็น 0
--    → average_rating = NULL, review_count = 0 (ตรงกับสถานะ "ยังไม่มีรีวิว")
CREATE OR REPLACE FUNCTION recalculate_caregiver_rating()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  affected_caregiver_id TEXT;
BEGIN
  -- เลือก caregiver_id ที่ได้รับผลกระทบจากแถวที่เปลี่ยน (DELETE ใช้ OLD)
  IF (TG_OP = 'DELETE') THEN
    affected_caregiver_id := OLD."caregiver_id";
  ELSE
    affected_caregiver_id := NEW."caregiver_id";
  END IF;

  -- คำนวณ aggregate ใหม่จากรีวิวที่มองเห็นได้ทั้งหมดของ caregiver คนนี้
  -- subquery แบบ aggregate (ไม่มี GROUP BY) คืน 1 แถวเสมอ → UPDATE ตรงเป้าเสมอ
  -- แม้ตอนลบรีวิวสุดท้ายออก (cnt = 0, avg = NULL)
  UPDATE "caregivers" c
  SET
    "average_rating" = agg.avg_rating,
    "review_count"   = agg.cnt
  FROM (
    SELECT
      ROUND(AVG("rating")::numeric, 2)::float8 AS avg_rating,
      COUNT(*)::int                            AS cnt
    FROM "reviews"
    WHERE "caregiver_id" = affected_caregiver_id
      AND "is_visible" = true
  ) AS agg
  WHERE c."id" = affected_caregiver_id;

  -- AFTER trigger → ค่าที่ return ถูกละทิ้ง ใช้ NULL ตามแบบมาตรฐาน
  RETURN NULL;
END;
$$;

-- ─── 4) ผูก trigger เข้ากับตาราง reviews ──────────────────────────────────────
-- ยิงหลังจาก: INSERT (รีวิวใหม่) / UPDATE เฉพาะคอลัมน์ is_visible (admin ซ่อน/โชว์) / DELETE
-- FOR EACH ROW = ยิงต่อ 1 แถวที่เปลี่ยน
-- DROP ก่อนเพื่อให้รัน migration ซ้ำได้แบบ idempotent
DROP TRIGGER IF EXISTS trg_recalc_rating ON "reviews";
CREATE TRIGGER trg_recalc_rating
AFTER INSERT OR UPDATE OF "is_visible" OR DELETE ON "reviews"
FOR EACH ROW
EXECUTE FUNCTION recalculate_caregiver_rating();
