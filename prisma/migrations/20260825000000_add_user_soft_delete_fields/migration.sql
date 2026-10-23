-- Fresh databases need the user soft-delete fields before the PYG-446 RLS
-- migration creates auth_user_role(), which reads users.is_deleted.
-- Existing environments received these fields manually, so keep this bridge
-- migration idempotent.
ALTER TABLE public."users"
    ADD COLUMN IF NOT EXISTS "scheduled_delete_at" TIMESTAMPTZ(6),
    ADD COLUMN IF NOT EXISTS "deletion_scheduled_by" TEXT,
    ADD COLUMN IF NOT EXISTS "is_deleted" BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS "deleted_at" TIMESTAMPTZ(6);

CREATE INDEX IF NOT EXISTS "idx_users_is_deleted"
    ON public."users"("is_deleted");

DO $do$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'public.users'::regclass
          AND conname = 'users_deletion_scheduled_by_fkey'
    ) THEN
        ALTER TABLE public."users"
            ADD CONSTRAINT "users_deletion_scheduled_by_fkey"
            FOREIGN KEY ("deletion_scheduled_by")
            REFERENCES public."users"("id")
            ON DELETE NO ACTION
            ON UPDATE NO ACTION;
    END IF;
END $do$;
