-- PYG-692 (การ์ดแม่ PYG-691) — ราคากายภาพบำบัดตามราคาจริง 800 บาท/ชม. (บริการอื่นคง 300 ไว้ก่อน)
--
-- ⚠ เขียนมือ ห้ามรัน prisma migrate dev / db push — deploy ด้วย `prisma migrate deploy` เท่านั้น
--
-- สิ่งที่ไฟล์นี้ทำ: UPDATE แถว service_type = 'physiotherapy' ใน service_price_catalog เป็น 800.00
--   ไม่แตะอีก 4 ประเภท (general_care, bedridden_care, medication, companion) · ไม่แก้ schema
--   booking เดิมใช้ bookings.estimated_cost ที่บันทึกตอนจองแล้ว → ไม่เปลี่ยน
--   ราคาใหม่มีผลกับ booking ที่สร้าง/ขอราคาหลังจากนี้ (activeHourlyPrice / display-price อ่านจากตารางนี้ทุกครั้ง)
--
-- GUARD: ต้องมีแถว physiotherapy 1 แถวพอดี และราคาเดิมเป็น 300.00 (seed) หรือ 800.00 (รันซ้ำ)
--   ราคาอื่น = มีคนแก้มือระหว่างทาง → ล้มทั้งไฟล์ ทบทวนก่อน
--
-- ตรวจก่อนรัน:
--   SELECT service_type, price_per_hour, is_active FROM service_price_catalog ORDER BY service_type;
--     → 5 แถว ราคา 300.00 ทุกแถว
--
-- Dry-run (Supabase evsewucpighcbnhofmug, 2026-10-23): DO-block เดียวกับไฟล์นี้ + RAISE EXCEPTION ท้าย
--   → physiotherapy 300.00 → 800.00 · อีก 4 แถว 300.00 · ยกเลิกทั้งหมด ไม่มีอะไรค้าง
--
-- ตรวจหลังรัน:
--   SELECT service_type, price_per_hour, is_active FROM service_price_catalog ORDER BY service_type;
--     → physiotherapy 800.00 · ที่เหลือ 300.00
--
-- ROLLBACK (มือ):
--   UPDATE "service_price_catalog" SET "price_per_hour" = 300.00, "updated_at" = CURRENT_TIMESTAMP
--    WHERE "service_type" = 'physiotherapy';
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261023000000_pyg691_physiotherapy_price_800';

DO $$
DECLARE
  n       integer;
  current numeric;
BEGIN
  SELECT count(*), max("price_per_hour") INTO n, current
    FROM "service_price_catalog"
   WHERE "service_type" = 'physiotherapy';
  IF n <> 1 OR current NOT IN (300.00, 800.00) THEN
    RAISE EXCEPTION 'PYG-692 guard: physiotherapy % แถว ราคา % (คาด 1 แถว ราคา 300.00 หรือ 800.00) — หยุด ทบทวนก่อน', n, current;
  END IF;
END
$$;

UPDATE "service_price_catalog"
   SET "price_per_hour" = 800.00,
       "updated_at"     = CURRENT_TIMESTAMP
 WHERE "service_type" = 'physiotherapy';
