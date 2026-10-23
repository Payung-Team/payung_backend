-- Reconcile schema changes that previously existed only in Prisma or were
-- applied manually. Keep conversions data-preserving so this migration can
-- also be used by existing environments.

ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'payment_refunded';

ALTER TABLE "caregiver_availability"
  ADD COLUMN IF NOT EXISTS "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP;

DO $do$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'caregiver_availability'
       AND column_name = 'time_slot'
       AND udt_name <> 'time_slot'
  ) THEN
    ALTER TABLE "caregiver_availability"
      ALTER COLUMN "time_slot" TYPE "time_slot"
      USING "time_slot"::text::"time_slot";
  END IF;
END
$do$;

ALTER TABLE "caregiver_job_types"
  ADD COLUMN IF NOT EXISTS "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP;

DO $do$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'caregiver_job_types'
       AND column_name = 'job_type'
       AND udt_name <> 'job_type'
  ) THEN
    ALTER TABLE "caregiver_job_types"
      ALTER COLUMN "job_type" TYPE "job_type"
      USING "job_type"::text::"job_type";
  END IF;
END
$do$;

ALTER TABLE "caregiver_job_types_removed_pyg559"
  ADD COLUMN IF NOT EXISTS "created_at" TIMESTAMPTZ(6);

DO $do$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'caregiver_job_types_removed_pyg559'
       AND column_name = 'job_type'
       AND udt_name <> 'job_type'
  ) THEN
    ALTER TABLE "caregiver_job_types_removed_pyg559"
      ALTER COLUMN "job_type" TYPE "job_type"
      USING "job_type"::text::"job_type";
  END IF;
END
$do$;

DO $do$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'caregiver_service_locations'
       AND column_name = 'service_location'
       AND udt_name <> 'service_location'
  ) THEN
    ALTER TABLE "caregiver_service_locations"
      ALTER COLUMN "service_location" TYPE "service_location"
      USING "service_location"::text::"service_location";
  END IF;
END
$do$;

ALTER TABLE "caregivers"
  ADD COLUMN IF NOT EXISTS "kyc_rejected_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "kyc_rejection_reason" TEXT,
  ADD COLUMN IF NOT EXISTS "rejection_reasons" JSONB;

DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM "reviews" WHERE "booking_id" IS NULL) THEN
    RAISE EXCEPTION 'Cannot require reviews.booking_id while NULL rows exist';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'reviews'
       AND column_name = 'booking_id'
       AND udt_name <> 'uuid'
  ) THEN
    ALTER TABLE "reviews"
      ALTER COLUMN "booking_id" TYPE UUID
      USING "booking_id"::uuid;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'reviews'
       AND column_name = 'created_at'
       AND data_type = 'timestamp without time zone'
  ) THEN
    ALTER TABLE "reviews"
      ALTER COLUMN "created_at" TYPE TIMESTAMPTZ(6)
      USING "created_at" AT TIME ZONE 'UTC';
  END IF;
END
$do$;

ALTER TABLE "reviews" ALTER COLUMN "booking_id" SET NOT NULL;

ALTER TABLE "saved_caregivers"
  ADD COLUMN IF NOT EXISTS "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "saved_caregivers"
  DROP CONSTRAINT IF EXISTS "saved_caregivers_caregiver_id_fkey",
  DROP CONSTRAINT IF EXISTS "saved_caregivers_patient_id_fkey",
  DROP CONSTRAINT IF EXISTS "saved_caregivers_pkey";

ALTER TABLE "saved_caregivers"
  ADD CONSTRAINT "saved_caregivers_pkey" PRIMARY KEY ("patient_id", "caregiver_id"),
  ADD CONSTRAINT "saved_caregivers_caregiver_id_fkey"
    FOREIGN KEY ("caregiver_id") REFERENCES "caregivers"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
  ADD CONSTRAINT "saved_caregivers_patient_id_fkey"
    FOREIGN KEY ("patient_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "district" TEXT,
  ADD COLUMN IF NOT EXISTS "invited_by" TEXT,
  ADD COLUMN IF NOT EXISTS "last_login_at" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "must_change_password" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "postal_code" TEXT,
  ADD COLUMN IF NOT EXISTS "province" TEXT,
  ADD COLUMN IF NOT EXISTS "sub_district" TEXT;

CREATE INDEX IF NOT EXISTS "idx_caregiver_availability_caregiver"
  ON "caregiver_availability"("caregiver_id");
CREATE UNIQUE INDEX IF NOT EXISTS "caregiver_availability_caregiver_id_day_of_week_time_slot_key"
  ON "caregiver_availability"("caregiver_id", "day_of_week", "time_slot");
CREATE INDEX IF NOT EXISTS "idx_caregiver_job_types_type"
  ON "caregiver_job_types"("job_type");
CREATE UNIQUE INDEX IF NOT EXISTS "caregiver_job_types_caregiver_id_job_type_key"
  ON "caregiver_job_types"("caregiver_id", "job_type");
CREATE INDEX IF NOT EXISTS "idx_caregiver_service_locations_type"
  ON "caregiver_service_locations"("service_location");
CREATE UNIQUE INDEX IF NOT EXISTS "caregiver_service_locations_caregiver_id_service_location_key"
  ON "caregiver_service_locations"("caregiver_id", "service_location");
CREATE INDEX IF NOT EXISTS "idx_kyc_documents_review_status"
  ON "kyc_documents"("review_status");
CREATE INDEX IF NOT EXISTS "kyc_documents_expires_at_idx"
  ON "kyc_documents"("expires_at");
CREATE INDEX IF NOT EXISTS "idx_kyc_reviews_document"
  ON "kyc_reviews"("document_id");
CREATE UNIQUE INDEX IF NOT EXISTS "reviews_booking_id_key"
  ON "reviews"("booking_id");
CREATE INDEX IF NOT EXISTS "idx_users_role"
  ON "users"("role");

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.users'::regclass
       AND conname = 'users_invited_by_fkey'
  ) THEN
    ALTER TABLE "users"
      ADD CONSTRAINT "users_invited_by_fkey"
      FOREIGN KEY ("invited_by") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.reviews'::regclass
       AND conname = 'reviews_booking_id_fkey'
  ) THEN
    ALTER TABLE "reviews"
      ADD CONSTRAINT "reviews_booking_id_fkey"
      FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
  END IF;
END
$do$;
