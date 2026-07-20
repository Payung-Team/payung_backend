-- PYG-316: Dispute filing metadata for the admin dispute queue
--
-- เพิ่ม 2 column บน bookings เพื่อรองรับ list/filter/sort ของ admin dispute queue:
--   dispute_filed_at = เวลาที่ patient กด flag (set ตอน flag)
--                      → ใช้คำนวณ SLA (sla_due_at = filed_at + 72h), filter ช่วงวันที่, และ sort by SLA
--   dispute_filed_by = ใครเป็นผู้ยื่น: 'customer' | 'caregiver'
--                      (ตอนนี้มีแต่ patient ที่ flag ได้ → ค่าเป็น 'customer' เสมอ; เผื่ออนาคต caregiver ยื่นได้)
--
-- IF NOT EXISTS ทั้งหมด → rerun ปลอดภัย (idempotent) ตามสไตล์ migration เดิม

ALTER TABLE "bookings"
  ADD COLUMN IF NOT EXISTS "dispute_filed_at" TIMESTAMPTZ;

ALTER TABLE "bookings"
  ADD COLUMN IF NOT EXISTS "dispute_filed_by" VARCHAR(20);

-- Backfill dispute เดิมที่มีอยู่ก่อน column นี้ (dispute_status != 'none'):
--   filed_at → ใช้ updated_at เป็น best-effort (ไม่มี timestamp จริงตอน flag ในของเดิม)
--   filed_by → 'customer' (ของเดิม flag ได้เฉพาะ patient)
UPDATE "bookings"
SET
  "dispute_filed_at" = COALESCE("dispute_filed_at", "updated_at"),
  "dispute_filed_by" = COALESCE("dispute_filed_by", 'customer')
WHERE "dispute_status" <> 'none';

-- Composite index สำหรับ queue: filter by dispute_status + sort by SLA (dispute_filed_at)
CREATE INDEX IF NOT EXISTS "idx_bookings_dispute_queue"
  ON "bookings"("dispute_status", "dispute_filed_at");
