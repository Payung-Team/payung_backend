-- Migration: booking_tasks_nullable_caregiver_saved_caregivers
-- Changes:
--   1. Add 'unmatched' and 'cancelled' to booking_status enum
--   2. Make bookings.caregiver_id nullable
--   3. Add tasks text[] column to bookings
--   4. Change default status to 'unmatched'
--   5. Re-create FK on caregiver_id as SET NULL
--   6. Create saved_caregivers table

-- ── 1. Extend booking_status enum ────────────────────────────────────────────
-- ALTER TYPE … ADD VALUE is idempotent-safe (IF NOT EXISTS)
DO $$ BEGIN
  ALTER TYPE booking_status ADD VALUE IF NOT EXISTS 'unmatched';
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TYPE booking_status ADD VALUE IF NOT EXISTS 'cancelled';
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- ── 2. Make caregiver_id nullable ─────────────────────────────────────────────
ALTER TABLE "bookings" ALTER COLUMN "caregiver_id" DROP NOT NULL;

-- ── 3. Add tasks column ────────────────────────────────────────────────────────
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "tasks" TEXT[] NOT NULL DEFAULT '{}';

-- ── 4. Update column default for status ────────────────────────────────────────
-- NOTE: existing rows keep their current status (no back-fill)
ALTER TABLE "bookings" ALTER COLUMN "status" SET DEFAULT 'unmatched';

-- ── 5. Drop old FK (CASCADE) and re-create as SET NULL ─────────────────────────
ALTER TABLE "bookings" DROP CONSTRAINT IF EXISTS "bookings_caregiver_id_fkey";
ALTER TABLE "bookings"
  ADD CONSTRAINT "bookings_caregiver_id_fkey"
  FOREIGN KEY ("caregiver_id") REFERENCES "caregivers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── 6. Create saved_caregivers table ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "saved_caregivers" (
  "id"           UUID        NOT NULL DEFAULT gen_random_uuid(),
  "patient_id"   TEXT        NOT NULL,
  "caregiver_id" TEXT        NOT NULL,
  "saved_at"     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT "saved_caregivers_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "saved_caregivers_patient_id_caregiver_id_key" UNIQUE ("patient_id", "caregiver_id"),
  CONSTRAINT "saved_caregivers_patient_id_fkey"
    FOREIGN KEY ("patient_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "saved_caregivers_caregiver_id_fkey"
    FOREIGN KEY ("caregiver_id") REFERENCES "caregivers"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "idx_saved_caregivers_patient" ON "saved_caregivers"("patient_id");
