-- Add accepted_at to bookings (PYG-206 — caregiver accepts a pending booking)
-- IF NOT EXISTS keeps this safe if the live DB already has the column.
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "accepted_at" TIMESTAMPTZ;
