-- PYG-341: Recover ghost tables + enums into migration history
--
-- Problem: 5 tables (care_recipients, bookings, booking_tasks, payments, field_locks)
-- and 8 enum types exist in the live DB + schema.prisma but have NO CREATE in any
-- migration (created historically via `db push`). A fresh `migrate deploy` therefore
-- dies at 20260601 ("relation bookings does not exist"), blocking new envs + migrate dev.
--
-- This migration recreates them at their ORIGINAL shape (the shape at first creation,
-- BEFORE later ALTERs), so the migrations that follow can replay their deltas and land
-- exactly on today's live schema. Verified by `prisma migrate diff` (Phase 3).
--
-- Timestamp 20260530000000: after users/caregivers (20260405*), before the first
-- migration that touches these tables (20260601 add_booking_confirmed_at).
--
-- 🔑 Every statement is IDEMPOTENT → this is a full CREATE on an empty DB, and a
--    complete no-op on the dev DB (tables/enums/constraints already exist).

-- ════════════════════════════════════════════════════════════════════════════
-- 1. Ghost enum types
--    booking_status is created with all 7 values (incl. unmatched/cancelled that
--    20260604 "adds") on purpose: 20260604 does SET DEFAULT 'unmatched' in the same
--    transaction it ADDs the value — using a value added in the same tx errors in PG.
--    Pre-creating them makes 20260604's ADD VALUE a no-op and the default safe.
--    End-state enum (values + order) is identical to live either way.
-- ════════════════════════════════════════════════════════════════════════════
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'booking_service_type') THEN
  CREATE TYPE "booking_service_type" AS ENUM ('general_care', 'bedridden_care', 'physiotherapy', 'medication', 'companion');
END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'booking_status') THEN
  CREATE TYPE "booking_status" AS ENUM ('pending', 'accepted', 'confirmed', 'rejected', 'completed', 'unmatched', 'cancelled');
END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'time_slot') THEN
  CREATE TYPE "time_slot" AS ENUM ('morning', 'afternoon', 'evening');
END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'job_type') THEN
  CREATE TYPE "job_type" AS ENUM ('general_care', 'bedridden_care', 'physiotherapy', 'medication', 'companion');
END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'service_location') THEN
  CREATE TYPE "service_location" AS ENUM ('at_home', 'accompany_outside');
END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'payment_status_enum') THEN
  CREATE TYPE "payment_status_enum" AS ENUM ('pending', 'held', 'captured', 'transferred', 'voided', 'refunded', 'partially_refunded', 'failed', 'expired');
END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'gender_enum') THEN
  CREATE TYPE "gender_enum" AS ENUM ('male', 'female');
END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'mobility_level') THEN
  CREATE TYPE "mobility_level" AS ENUM ('independent', 'assisted', 'wheelchair', 'bedridden');
END IF; END $$;

-- ════════════════════════════════════════════════════════════════════════════
-- 2. care_recipients  (no later ALTERs — original == current)
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS "care_recipients" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "patient_id" TEXT NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "nickname" VARCHAR(100),
    "date_of_birth" DATE,
    "gender" "gender_enum",
    "weight_kg" DECIMAL(5,2),
    "height_cm" DECIMAL(5,2),
    "mobility_level" "mobility_level",
    "medical_conditions" TEXT[],
    "current_medications" TEXT,
    "allergies" TEXT,
    "blood_type" VARCHAR(5),
    "address_line" TEXT,
    "province" VARCHAR(100),
    "district" VARCHAR(100),
    "lat" DECIMAL(10,7),
    "lng" DECIMAL(10,7),
    "emergency_contact_name" TEXT,
    "emergency_contact_phone" TEXT,
    "emergency_contact_rel" TEXT,
    "preferred_hospital" TEXT,
    "is_self" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "care_recipients_pkey" PRIMARY KEY ("id")
);

-- ════════════════════════════════════════════════════════════════════════════
-- 3. bookings  (ORIGINAL shape — later ALTERs re-derive today's shape)
--    Removed (added by later migrations): confirmed_at(20260601), tasks(20260604),
--    accepted_at(20260607), notes/day_of_contact_*(20260620000),
--    dispute_status/reason/resolved_at(20260621000), patient_name(20260621001),
--    completed_at(20260622000), dispute_filed_at/by(20260717120).
--    Original: service_type/time_slot/status are ENUM (20260620001 → TEXT),
--    caregiver_id NOT NULL (20260604 → nullable), status has no default
--    (20260604 → DEFAULT 'unmatched').
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS "bookings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "patient_id" TEXT NOT NULL,
    "caregiver_id" TEXT NOT NULL,
    "care_recipient_id" UUID,
    "service_locations" TEXT[],
    "service_type" "booking_service_type" NOT NULL,
    "time_slot" "time_slot" NOT NULL,
    "start_time" TIME(6) NOT NULL,
    "duration_hours" DECIMAL NOT NULL,
    "location_address" TEXT NOT NULL,
    "location_lat" DECIMAL(10,7),
    "location_lng" DECIMAL(10,7),
    "status" "booking_status" NOT NULL,
    "rejection_reason" TEXT,
    "estimated_cost" DECIMAL(10,2),
    "platform_fee" DECIMAL(10,2),
    "booking_date" DATE NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "bookings_pkey" PRIMARY KEY ("id")
);

-- ════════════════════════════════════════════════════════════════════════════
-- 4. booking_tasks  (no later ALTERs — original == current)
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS "booking_tasks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "booking_id" UUID NOT NULL,
    "description" TEXT NOT NULL,
    "is_suggested" BOOLEAN NOT NULL DEFAULT false,
    "is_custom" BOOLEAN NOT NULL DEFAULT false,
    "time_note" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "booking_tasks_pkey" PRIMARY KEY ("id")
);

-- ════════════════════════════════════════════════════════════════════════════
-- 5. payments  (original — idx_payments_created_at added later by 20260720)
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS "payments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "booking_id" UUID NOT NULL,
    "patient_id" TEXT NOT NULL,
    "caregiver_id" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'THB',
    "omise_charge_id" TEXT,
    "omise_token" TEXT,
    "payment_method" VARCHAR(20) NOT NULL DEFAULT 'credit_card',
    "payment_status" "payment_status_enum" NOT NULL DEFAULT 'pending',
    "failure_code" TEXT,
    "failure_message" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- ════════════════════════════════════════════════════════════════════════════
-- 6. field_locks  (no later ALTERs — original == current)
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS "field_locks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "field_name" TEXT NOT NULL,
    "locked_by" TEXT NOT NULL,
    "locked_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unlocked_at" TIMESTAMPTZ(6),
    "unlocked_by" TEXT,
    CONSTRAINT "field_locks_pkey" PRIMARY KEY ("id")
);

-- ════════════════════════════════════════════════════════════════════════════
-- 7. Indexes (original set only — dispute/created_at indexes come from later migrations)
-- ════════════════════════════════════════════════════════════════════════════
CREATE INDEX IF NOT EXISTS "idx_care_recipients_patient" ON "care_recipients" ("patient_id");

CREATE INDEX IF NOT EXISTS "idx_bookings_caregiver" ON "bookings" ("caregiver_id");
CREATE INDEX IF NOT EXISTS "idx_bookings_date" ON "bookings" ("booking_date");
CREATE INDEX IF NOT EXISTS "idx_bookings_patient" ON "bookings" ("patient_id");
CREATE INDEX IF NOT EXISTS "idx_bookings_status" ON "bookings" ("status");

CREATE INDEX IF NOT EXISTS "idx_booking_tasks_booking" ON "booking_tasks" ("booking_id");

CREATE UNIQUE INDEX IF NOT EXISTS "idx_payments_booking" ON "payments" ("booking_id");
CREATE INDEX IF NOT EXISTS "idx_payments_patient" ON "payments" ("patient_id");
CREATE INDEX IF NOT EXISTS "idx_payments_status" ON "payments" ("payment_status");

CREATE UNIQUE INDEX IF NOT EXISTS "field_locks_entity_type_entity_id_field_name_key" ON "field_locks" ("entity_type", "entity_id", "field_name");
CREATE INDEX IF NOT EXISTS "idx_field_locks_locked_by" ON "field_locks" ("locked_by");

-- ════════════════════════════════════════════════════════════════════════════
-- 8. Foreign keys (idempotent via pg_constraint check)
--    bookings.caregiver_id FK is ON DELETE CASCADE originally; 20260604 replaces it
--    with SET NULL. On dev DB the (SET NULL) constraint already exists → skipped.
-- ════════════════════════════════════════════════════════════════════════════
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'care_recipients_patient_id_fkey') THEN
  ALTER TABLE "care_recipients" ADD CONSTRAINT "care_recipients_patient_id_fkey"
    FOREIGN KEY ("patient_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION;
END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bookings_care_recipient_id_fkey') THEN
  ALTER TABLE "bookings" ADD CONSTRAINT "bookings_care_recipient_id_fkey"
    FOREIGN KEY ("care_recipient_id") REFERENCES "care_recipients" ("id") ON DELETE SET NULL ON UPDATE NO ACTION;
END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bookings_caregiver_id_fkey') THEN
  ALTER TABLE "bookings" ADD CONSTRAINT "bookings_caregiver_id_fkey"
    FOREIGN KEY ("caregiver_id") REFERENCES "caregivers" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bookings_patient_id_fkey') THEN
  ALTER TABLE "bookings" ADD CONSTRAINT "bookings_patient_id_fkey"
    FOREIGN KEY ("patient_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION;
END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'booking_tasks_booking_id_fkey') THEN
  ALTER TABLE "booking_tasks" ADD CONSTRAINT "booking_tasks_booking_id_fkey"
    FOREIGN KEY ("booking_id") REFERENCES "bookings" ("id") ON DELETE CASCADE ON UPDATE NO ACTION;
END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payments_booking') THEN
  ALTER TABLE "payments" ADD CONSTRAINT "fk_payments_booking"
    FOREIGN KEY ("booking_id") REFERENCES "bookings" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION;
END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payments_caregiver') THEN
  ALTER TABLE "payments" ADD CONSTRAINT "fk_payments_caregiver"
    FOREIGN KEY ("caregiver_id") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION;
END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payments_patient') THEN
  ALTER TABLE "payments" ADD CONSTRAINT "fk_payments_patient"
    FOREIGN KEY ("patient_id") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION;
END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'field_locks_locked_by_fkey') THEN
  ALTER TABLE "field_locks" ADD CONSTRAINT "field_locks_locked_by_fkey"
    FOREIGN KEY ("locked_by") REFERENCES "users" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'field_locks_unlocked_by_fkey') THEN
  ALTER TABLE "field_locks" ADD CONSTRAINT "field_locks_unlocked_by_fkey"
    FOREIGN KEY ("unlocked_by") REFERENCES "users" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
END IF; END $$;
