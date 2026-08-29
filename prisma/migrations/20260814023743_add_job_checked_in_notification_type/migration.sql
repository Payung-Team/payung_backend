-- PYG-353: notification type for caregiver job check-in
--
-- ADD-only: we add the value but never USE it in this migration, so ALTER TYPE … ADD VALUE
-- is safe inside the migration transaction (PG15). Christina wires the listener after Sam deploys.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'job_checked_in';
