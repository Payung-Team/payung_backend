-- Add search-related columns to caregivers
ALTER TABLE "caregivers"
  ADD COLUMN IF NOT EXISTS "service_area_province" VARCHAR,
  ADD COLUMN IF NOT EXISTS "service_area_district" VARCHAR,
  ADD COLUMN IF NOT EXISTS "languages"             TEXT[] NOT NULL DEFAULT '{}';

-- caregiver_job_types
CREATE TABLE IF NOT EXISTS "caregiver_job_types" (
  "id"           UUID NOT NULL DEFAULT gen_random_uuid(),
  "caregiver_id" TEXT NOT NULL,
  "job_type"     TEXT NOT NULL,
  CONSTRAINT "caregiver_job_types_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "caregiver_job_types_caregiver_id_job_type_key" UNIQUE ("caregiver_id", "job_type"),
  CONSTRAINT "caregiver_job_types_caregiver_id_fkey"
    FOREIGN KEY ("caregiver_id") REFERENCES "caregivers"("id") ON DELETE CASCADE
);

-- caregiver_availability
CREATE TABLE IF NOT EXISTS "caregiver_availability" (
  "id"           UUID        NOT NULL DEFAULT gen_random_uuid(),
  "caregiver_id" TEXT        NOT NULL,
  "day_of_week"  SMALLINT    NOT NULL,
  "time_slot"    TEXT        NOT NULL,
  "is_active"    BOOLEAN     NOT NULL DEFAULT true,
  CONSTRAINT "caregiver_availability_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "caregiver_availability_caregiver_id_day_of_week_time_slot_key"
    UNIQUE ("caregiver_id", "day_of_week", "time_slot"),
  CONSTRAINT "caregiver_availability_caregiver_id_fkey"
    FOREIGN KEY ("caregiver_id") REFERENCES "caregivers"("id") ON DELETE CASCADE
);

-- reviews (patient → caregiver ratings, separate from kyc_reviews)
CREATE TABLE IF NOT EXISTS "reviews" (
  "id"           UUID    NOT NULL DEFAULT gen_random_uuid(),
  "caregiver_id" TEXT    NOT NULL,
  "patient_id"   TEXT    NOT NULL,
  "booking_id"   TEXT,
  "rating"       INTEGER NOT NULL CHECK ("rating" BETWEEN 1 AND 5),
  "comment"      TEXT,
  "is_anonymous" BOOLEAN NOT NULL DEFAULT false,
  "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "reviews_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "reviews_caregiver_id_fkey"
    FOREIGN KEY ("caregiver_id") REFERENCES "caregivers"("id") ON DELETE CASCADE,
  CONSTRAINT "reviews_patient_id_fkey"
    FOREIGN KEY ("patient_id") REFERENCES "users"("id") ON DELETE CASCADE
);

-- Indexes
CREATE INDEX IF NOT EXISTS "idx_caregivers_service_area"
  ON "caregivers"("service_area_province", "service_area_district");

CREATE INDEX IF NOT EXISTS "idx_caregiver_job_types_type"
  ON "caregiver_job_types"("job_type");

CREATE INDEX IF NOT EXISTS "idx_caregiver_job_types_caregiver"
  ON "caregiver_job_types"("caregiver_id");

CREATE INDEX IF NOT EXISTS "idx_caregiver_availability_day_slot"
  ON "caregiver_availability"("day_of_week", "time_slot") WHERE is_active = true;

CREATE INDEX IF NOT EXISTS "idx_reviews_caregiver"
  ON "reviews"("caregiver_id");
