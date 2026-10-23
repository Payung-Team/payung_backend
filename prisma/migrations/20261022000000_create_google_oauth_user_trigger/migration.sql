-- Keep Supabase Auth and the application's public.users table in sync for
-- Google OAuth sign-ups. Password and phone registrations are provisioned by
-- the backend and must not be duplicated by this trigger.

BEGIN;

CREATE OR REPLACE FUNCTION public.handle_new_google_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
    IF NEW.raw_app_meta_data->>'provider' = 'google' THEN
        INSERT INTO public.users (
            id,
            supabase_uid,
            email,
            display_name,
            avatar_url,
            role,
            is_active,
            created_at,
            updated_at
        )
        VALUES (
            gen_random_uuid()::text,
            NEW.id::text,
            NEW.email,
            COALESCE(
                NULLIF(BTRIM(NEW.raw_user_meta_data->>'full_name'), ''),
                NULLIF(
                    BTRIM(CONCAT(
                        NEW.raw_user_meta_data->>'given_name',
                        ' ',
                        NEW.raw_user_meta_data->>'family_name'
                    )),
                    ''
                ),
                NULLIF(SPLIT_PART(COALESCE(NEW.email, ''), '@', 1), '')
            ),
            COALESCE(
                NEW.raw_user_meta_data->>'avatar_url',
                NEW.raw_user_meta_data->>'picture'
            ),
            1,
            true,
            NOW(),
            NOW()
        )
        ON CONFLICT (supabase_uid) DO UPDATE
        SET avatar_url = COALESCE(EXCLUDED.avatar_url, public.users.avatar_url),
            updated_at = NOW();
    END IF;

    RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.handle_new_google_user() IS
    'Creates or refreshes the public.users row for a Google OAuth identity.';

-- auth.users exists on Supabase. The guard keeps Prisma's plain-Postgres
-- shadow database replayable because its compatibility shim only defines
-- auth.uid(), not the Supabase-managed auth.users table.
DO $block$
BEGIN
    IF TO_REGCLASS('auth.users') IS NOT NULL THEN
        DROP TRIGGER IF EXISTS on_google_auth_user_created ON auth.users;

        CREATE TRIGGER on_google_auth_user_created
        AFTER INSERT ON auth.users
        FOR EACH ROW
        EXECUTE FUNCTION public.handle_new_google_user();
    END IF;
END
$block$;

COMMIT;

-- Rollback (manual):
-- DROP TRIGGER IF EXISTS on_google_auth_user_created ON auth.users;
-- DROP FUNCTION IF EXISTS public.handle_new_google_user();
