-- Migration: เพิ่มตาราง caregiver_service_locations (PYG-259)
--
-- วัตถุประสงค์:
-- - แยก "สถานที่ให้บริการ" (service location: at_home / accompany_outside)
--   ออกจาก "ประเภทงาน" (job type) ใน Work Condition API
-- - เดิม FE ต้องยัดทั้งสองอย่างปนกันใน jobTypes[] → column ไม่ตรงกับหน้าจอ FE
-- - ตารางนี้ล้อโครงสร้าง caregiver_job_types ทุกอย่าง (1 แถว = 1 service location)
--
-- ใช้ IF NOT EXISTS ทุกที่ เพื่อให้ rerun ได้ปลอดภัย (idempotent) ตาม pattern
-- ของ migration เดิมในโปรเจกต์

CREATE TABLE IF NOT EXISTS "caregiver_service_locations" (
  "id"               UUID NOT NULL DEFAULT gen_random_uuid(),
  "caregiver_id"     TEXT NOT NULL,
  "service_location" TEXT NOT NULL,
  CONSTRAINT "caregiver_service_locations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "caregiver_service_locations_caregiver_id_service_location_key"
    UNIQUE ("caregiver_id", "service_location"),
  CONSTRAINT "caregiver_service_locations_caregiver_id_fkey"
    FOREIGN KEY ("caregiver_id") REFERENCES "caregivers"("id") ON DELETE CASCADE
);

-- Indexes — ค้นด้วย service location (ฝั่ง matching) และด้วย caregiver (ฝั่ง read/replace)
CREATE INDEX IF NOT EXISTS "idx_caregiver_service_locations_type"
  ON "caregiver_service_locations"("service_location");

CREATE INDEX IF NOT EXISTS "idx_caregiver_service_locations_caregiver"
  ON "caregiver_service_locations"("caregiver_id");
