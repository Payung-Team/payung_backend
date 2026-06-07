-- Step 1: Add new enum values (must be in their own transaction, committed before use)
DO $$ BEGIN
  ALTER TYPE booking_status ADD VALUE IF NOT EXISTS 'unmatched';
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TYPE booking_status ADD VALUE IF NOT EXISTS 'cancelled';
EXCEPTION WHEN duplicate_object THEN null;
END $$;
