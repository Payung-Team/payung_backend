-- PYG-287: Dispute flow — เพิ่ม column สำหรับ flag/resolve dispute บน bookings
--
-- ค่าใน dispute_status:
--   'none'     = ปกติ (default)
--   'flagged'  = patient flag → รอ admin ตรวจ
--   'resolved' = admin ตัดสินแล้ว (no_refund | refund_full | refund_partial)
--
-- IF NOT EXISTS ทั้งหมด → rerun ปลอดภัย (idempotent)

ALTER TABLE "bookings"
  ADD COLUMN IF NOT EXISTS "dispute_status"      VARCHAR(20)   NOT NULL DEFAULT 'none';

ALTER TABLE "bookings"
  ADD COLUMN IF NOT EXISTS "dispute_reason"      TEXT;

ALTER TABLE "bookings"
  ADD COLUMN IF NOT EXISTS "dispute_resolved_at" TIMESTAMPTZ;

-- index สำหรับ adminDisputes ที่ filter by dispute_status (default 'flagged')
CREATE INDEX IF NOT EXISTS "idx_bookings_dispute_status"
  ON "bookings"("dispute_status");
