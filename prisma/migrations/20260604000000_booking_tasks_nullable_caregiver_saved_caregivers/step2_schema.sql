-- Step 2: Schema changes (run after step1_enum.sql is committed)

-- ── Make caregiver_id nullable ────────────────────────────────────────────────
ALTER TABLE "bookings" ALTER COLUMN "caregiver_id" DROP NOT NULL;

-- ── Add tasks column ──────────────────────────────────────────────────────────
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "tasks" TEXT[] NOT NULL DEFAULT '{}';

-- ── Update column default for status ──────────────────────────────────────────
ALTER TABLE "bookings" ALTER COLUMN "status" SET DEFAULT 'unmatched';

-- ── Re-create caregiver_id FK as SET NULL on delete ───────────────────────────
ALTER TABLE "bookings" DROP CONSTRAINT IF EXISTS "bookings_caregiver_id_fkey";
ALTER TABLE "bookings"
  ADD CONSTRAINT "bookings_caregiver_id_fkey"
  FOREIGN KEY ("caregiver_id") REFERENCES "caregivers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── Create saved_caregivers table ─────────────────────────────────────────────
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
