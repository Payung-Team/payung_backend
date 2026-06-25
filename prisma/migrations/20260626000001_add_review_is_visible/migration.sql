-- PYG-297: Reviews CRUD (createReview / caregiverReviews / hideReview)
--
-- หมายเหตุ: ตาราง "reviews" มีอยู่แล้ว — ถูกสร้างใน
-- 20260531000000_add_caregiver_search_tables (PYG-192) เพื่อใช้คำนวณ
-- avg_rating / review_count ของ caregiver แบบ live (ตอนนั้นยังไม่มีฟีเจอร์เขียนรีวิว)
--
-- ไฟล์นี้เพิ่มสิ่งที่ฟีเจอร์รีวิวต้องใช้เพิ่ม:
--   1) is_visible  → ให้ admin "ซ่อน" รีวิวที่ไม่เหมาะสมได้ (hideReview)
--   2) unique(booking_id) → บังคับ 1 รีวิว/1 booking (ตรงกับ Prisma `bookingId @unique`)
--   3) index(patient_id)  → ค้นรีวิวตาม patient ได้เร็ว (ตรงกับ @@index idx_reviews_patient)

-- 1) ธงซ่อนรีวิว — default true เพื่อให้รีวิวเดิมทั้งหมดยังมองเห็นได้ตามปกติ
ALTER TABLE "reviews"
  ADD COLUMN IF NOT EXISTS "is_visible" BOOLEAN NOT NULL DEFAULT true;

-- 2) 1 รีวิว/1 booking — กัน patient รีวิวซ้ำใน booking เดียวกัน
--    (Postgres อนุญาตให้ booking_id ที่เป็น NULL ซ้ำกันได้ จึงปลอดภัยกับแถวเก่าที่ยังไม่มี booking_id)
CREATE UNIQUE INDEX IF NOT EXISTS "reviews_booking_id_key" ON "reviews"("booking_id");

-- 3) index สำหรับค้นรีวิวตาม patient
CREATE INDEX IF NOT EXISTS "idx_reviews_patient" ON "reviews"("patient_id");
