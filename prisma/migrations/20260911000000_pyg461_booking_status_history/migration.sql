-- PYG-461/462 — booking_status_history: audit trail ของการเปลี่ยน bookings.status (append-only)
--
-- ⚠ เขียนมือทั้งหมด ห้ามรัน prisma migrate dev / db push — Wasan เป็นคนรัน `prisma migrate deploy` เท่านั้น
--
-- ขอบเขต (ล็อกไว้ตามมติ 2026-09-11):
--   - CREATE TABLE + CREATE INDEX ล้วน — ไม่มี backfill, ไม่แตะข้อมูลเดิม, ไม่ ALTER ตารางอื่น
--     (FK ประกาศ inline ใน CREATE TABLE ของตารางใหม่เอง ไม่ได้ ALTER bookings)
--   - คอลัมน์ตามที่อนุมัติเท่านั้น + "id" ซึ่งเป็น PK ที่ Prisma บังคับให้ทุก model ต้องมี
--   - ไม่มี RLS / GRANT: mirror payment_status_history + payout_status_history
--     (public ไม่มี default ACL → ตารางใหม่มีสิทธิ์แค่ postgres, anon/authenticated อ่านไม่ได้)
--   - append-only บังคับที่ระดับแอป: มีตัวเขียนตัวเดียวคือ recordBookingStatusChange()
--     (src/booking/booking-status-history.ts) ซึ่งทำได้แค่ INSERT
--
-- ชนิดคอลัมน์:
--   - from_status / to_status เป็น TEXT เพราะ bookings.status เป็น TEXT (ดู 20260620000001_convert_booking_enums_to_text)
--   - changed_by เป็น TEXT (users.id) ไม่มี FK โดยตั้งใจ — audit ต้องอยู่ต่อได้แม้ user ถูกลบ
--     และ NULL = ระบบ/cron เป็นคนเปลี่ยน
--   - created_at เป็น TIMESTAMPTZ ตามมติ Sprint 6 (timestamp ที่เกี่ยวกับเงินใช้ timestamptz เสมอ)
--
-- ROLLBACK (ปลอดภัยเฉพาะก่อนมีโค้ดที่เขียนตารางนี้ถูก deploy — ลบแล้ว audit ที่เขียนไปแล้วหายด้วย):
--   DROP TABLE IF EXISTS "booking_status_history";
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20260911000000_pyg461_booking_status_history';

CREATE TABLE "booking_status_history" (
    "id"          UUID NOT NULL DEFAULT gen_random_uuid(),
    "booking_id"  UUID NOT NULL,
    "from_status" TEXT,
    "to_status"   TEXT NOT NULL,
    "changed_by"  TEXT,
    "reason"      TEXT,
    "metadata"    JSONB,
    "created_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "booking_status_history_pkey" PRIMARY KEY ("id"),
    -- ON DELETE CASCADE: mirror fk_psh_payment — booking ถูกลบ (เช่น patient ถูกลบแบบ cascade) history ไปด้วย
    CONSTRAINT "fk_bsh_booking" FOREIGN KEY ("booking_id")
        REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

-- อ่าน timeline ของ booking ใบเดียวเรียงตามเวลา
CREATE INDEX "idx_bsh_booking_created" ON "booking_status_history"("booking_id", "created_at");
