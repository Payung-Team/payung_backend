-- PYG-638 — กายภาพบำบัด (บริการ F03) มีผลต่อระดับของ booking = ระดับสูง
--
-- การ์ดแม่: PYG-569 (S16) · Sammy เคาะ 9 ต.ค. 2026: ยึดตาม infographic → บริการ F03 = ระดับสูง
--   แทนมติ 8 ต.ค. 2026 ที่ให้แถวนี้เป็นระดับว่าง ("ไม่มีผลต่อระดับ" — 20261008060000_pyg569_seed_booking_level_rules)
--
-- ⚠ เขียนมือ ห้ามรัน prisma migrate dev / db push — Sammy gate และรัน `prisma migrate deploy` เท่านั้น
--
-- ต้องโดน 1 แถวเท่านั้น — post-assertion ท้ายไฟล์ทำให้ migration ล้มถ้าแถวไม่อยู่ในสถานะที่คาด
-- รันซ้ำได้: WHERE จับคู่ด้วยค่าเดิม (level IS NULL) รอบสองไม่โดนแถวใด
--
-- ROLLBACK (มือ):
--   UPDATE "booking_level_rules" SET "level" = NULL, "updated_at" = now()
--    WHERE "source" = 'service' AND "code" = 'F03' AND "variant" = '' AND "level" = 'advanced';
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261009010000_pyg638_f03_level_advanced';

UPDATE "booking_level_rules"
   SET "level" = 'advanced', "updated_at" = now()
 WHERE "source" = 'service' AND "code" = 'F03' AND "variant" = '' AND "level" IS NULL;

DO $$
DECLARE
    f03_level TEXT;
    f03_rows  INTEGER;
BEGIN
    SELECT count(*), max("level") INTO f03_rows, f03_level
      FROM "booking_level_rules"
     WHERE "source" = 'service' AND "code" = 'F03' AND "variant" = '';

    IF f03_rows <> 1 OR f03_level IS DISTINCT FROM 'advanced' THEN
        RAISE EXCEPTION 'PYG-638: แถว service/F03 ไม่อยู่ในสถานะที่คาด (rows=%, level=%)', f03_rows, f03_level;
    END IF;
END $$;
