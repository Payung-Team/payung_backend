-- Add completed_at to bookings (PYG-281 — completeBooking captures charge + completes the job)
-- completed_at = เวลาที่งานเสร็จและ capture เงินสำเร็จ (booking: confirmed → completed)
-- IF NOT EXISTS keeps this safe if the live DB already has the column.
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "completed_at" TIMESTAMPTZ;
