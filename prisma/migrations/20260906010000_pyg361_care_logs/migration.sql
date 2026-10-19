-- PYG-361 — "บันทึกจากผู้ดูแล" (care_logs) + RLS + realtime + NotificationType ใหม่
--
-- ⚠ เขียนมือทั้งหมด ห้ามรัน prisma migrate dev / db push — Sammy เป็นคนรัน migrate deploy เท่านั้น

CREATE TABLE "care_logs" (
    "id"           UUID NOT NULL DEFAULT gen_random_uuid(),
    "booking_id"   UUID NOT NULL,
    "caregiver_id" TEXT NOT NULL,
    "category"     TEXT NOT NULL,
    "body"         TEXT NOT NULL,
    "photo_url"    TEXT,
    "server_ts"    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "device_ts"    TIMESTAMPTZ(6),
    "created_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "care_logs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "care_logs_category_check" CHECK ("category" IN ('vitals','food','medication','activity','other')),
    CONSTRAINT "care_logs_body_length_check" CHECK (char_length("body") <= 500),
    -- ★ กันไว้ที่ระดับ DB ด้วย ห้ามเป็น URL เต็มเด็ดขาด (เก็บได้แค่ storage path เช่น
    --   '{bookingId}/care-log-xxx.jpg') — เหตุผลเดียวกับที่ PR #39 แก้ kyc_documents
    --   ILIKE (ไม่ใช่ LIKE) กัน 'HTTP://'/'Http://' หลุดผ่านด้วย
    --   NOT LIKE '//%' กัน protocol-relative URL ('//host/path') ที่ ILIKE 'http%' จับไม่ได้
    CONSTRAINT "care_logs_photo_url_not_full_url_check"
        CHECK (
            "photo_url" IS NULL
            OR ("photo_url" NOT ILIKE 'http%' AND "photo_url" NOT LIKE '//%')
        )
);

CREATE INDEX "idx_care_logs_booking_ts" ON "care_logs"("booking_id", "server_ts" DESC);

ALTER TABLE "care_logs" ADD CONSTRAINT "care_logs_booking_id_fkey"
    FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ⚠ ON DELETE RESTRICT: ตั้งใจ — ลบ caregiver ที่ยังมีบันทึกการดูแลอยู่ไม่ได้
--   งานล้างข้อมูล caregiver เก่าต้องลบ care_logs ก่อนตามลำดับ (เหมือน kyc_reviews / caregiver_edit_logs)
ALTER TABLE "care_logs" ADD CONSTRAINT "care_logs_caregiver_id_fkey"
    FOREIGN KEY ("caregiver_id") REFERENCES "caregivers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── Realtime ───────────────────────────────────────────────────────────────
-- insufficient_privilege ต้องดักด้วย: publication supabase_realtime เจ้าของคือ supabase_admin
-- ไม่ใช่ postgres ถ้าโดนปฏิเสธจะไม่ใช่ duplicate_object และไม่ใช่ undefined_object
DO $$
BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE "care_logs";
EXCEPTION
    WHEN duplicate_object THEN
        RAISE NOTICE 'PYG-361: care_logs อยู่ใน supabase_realtime อยู่แล้ว — ข้าม';
    WHEN undefined_object THEN
        RAISE NOTICE 'PYG-361: ไม่พบ publication supabase_realtime — ข้าม';
    WHEN insufficient_privilege THEN
        RAISE NOTICE 'PYG-361: ไม่มีสิทธิ์แก้ publication supabase_realtime — ข้าม';
END $$;

-- ─── RLS ───────────────────────────────────────────────────────────────────
ALTER TABLE "care_logs" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "care_logs_select_participants" ON "care_logs"
    FOR SELECT
    TO authenticated
    USING (
        booking_id IN (
            SELECT b.id FROM bookings b
            LEFT JOIN caregivers c ON c.id = b.caregiver_id
            WHERE b.patient_id IN (SELECT id FROM users WHERE supabase_uid = auth.uid()::text)
               OR c.user_id     IN (SELECT id FROM users WHERE supabase_uid = auth.uid()::text)
        )
    );

-- ★ ไม่มี policy INSERT/UPDATE/DELETE ให้ client — เขียนได้ผ่าน backend เท่านั้น

-- ─── NotificationType ใหม่ (แจ้งเตือนเฉพาะรายการแรกของงาน — มติ PO 2026-09-06) ────
DO $$ BEGIN
  ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'job_care_log_added';
EXCEPTION WHEN duplicate_object THEN null; END $$;
