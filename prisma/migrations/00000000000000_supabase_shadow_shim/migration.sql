-- Supabase compatibility shim for `prisma migrate dev` shadow database
--
-- Purpose:
--   `prisma migrate dev` replays every past migration against a shadow DB before
--   creating a new one. Migration 20260424100000_add_notifications_and_email_preferences
--   uses Supabase's built-in `auth.uid()` function inside RLS policies:
--
--     CREATE POLICY ... USING (user_id IN (SELECT id FROM users WHERE supabase_uid = auth.uid()::text));
--
--   On our production/staging Supabase, `auth.uid()` exists at project bootstrap.
--   On a fresh plain-Postgres shadow (docker-compose.dev.yml), it does not →
--   replay fails with P3006, blocking `migrate dev`.
--
-- What this file does:
--   Creates the minimum shim required by the migrations actually in this repo:
--     1. schema `auth`
--     2. function `auth.uid()` returning uuid (Supabase's real signature)
--
--   Verified by grepping all 27 pre-existing migrations (as of 2026-07-16):
--     - No other auth.* function is referenced (grep -E 'auth\.(uid|users|jwt|role|email|sub)')
--     - No CREATE EXTENSION statements
--     - No references to other Supabase schemas (storage, realtime, extensions,
--       vault, net, graphql_public)
--     - Role names anon/authenticated/service_role appear ONLY in comments —
--       no GRANT/REVOKE/ALTER DEFAULT PRIVILEGES references them
--
--   → the shim intentionally covers only auth + auth.uid(). If a future
--     migration references something else (e.g. auth.role()), extend this file.
--
-- Safety on real Supabase:
--   - `CREATE SCHEMA IF NOT EXISTS auth` → no-op (schema exists)
--   - `CREATE FUNCTION auth.uid()` is guarded by an explicit pg_proc check →
--     no-op if the function exists (which it always does on Supabase)
--   - **NO `CREATE OR REPLACE`** anywhere — we never overwrite the real
--     Supabase-provided auth.uid()
--
--   This means the shim is safe to record as "applied" on the Supabase side
--   via `prisma migrate resolve --applied` without ever executing against it.
--
-- Ticket: PYG-shadow-db-setup

CREATE SCHEMA IF NOT EXISTS auth;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'auth' AND p.proname = 'uid'
    ) THEN
        CREATE FUNCTION auth.uid() RETURNS uuid
        LANGUAGE sql STABLE
        AS $fn$ SELECT NULL::uuid $fn$;
    END IF;
END $$;
