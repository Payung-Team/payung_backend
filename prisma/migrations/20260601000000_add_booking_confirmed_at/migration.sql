-- Add confirmed_at to bookings if it doesn't already exist (live DB may already have it)
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "confirmed_at" TIMESTAMPTZ;
