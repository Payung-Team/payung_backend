-- Create the private bucket used by the caregiver KYC flow.
--
-- Object paths must start with the authenticated user's Supabase UID:
--   <auth.uid()>/<timestamp>-<document-type>.<extension>
--
-- The frontend uploads and previews its own pending documents directly. The
-- backend uses the service-role client for administrative access and signed
-- URLs, so it is not restricted by these authenticated-user policies.

BEGIN;

INSERT INTO storage.buckets (
    id,
    name,
    public,
    file_size_limit,
    allowed_mime_types
)
VALUES (
    'kyc-documents',
    'kyc-documents',
    false,
    5242880,
    ARRAY['image/jpeg', 'image/png', 'application/pdf']
)
ON CONFLICT (id) DO UPDATE
SET public             = EXCLUDED.public,
    file_size_limit    = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "kyc_documents_select_own" ON storage.objects;
CREATE POLICY "kyc_documents_select_own"
ON storage.objects
FOR SELECT
TO authenticated
USING (
    bucket_id = 'kyc-documents'
    AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
);

DROP POLICY IF EXISTS "kyc_documents_insert_own" ON storage.objects;
CREATE POLICY "kyc_documents_insert_own"
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
    bucket_id = 'kyc-documents'
    AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
);

DROP POLICY IF EXISTS "kyc_documents_update_own" ON storage.objects;
CREATE POLICY "kyc_documents_update_own"
ON storage.objects
FOR UPDATE
TO authenticated
USING (
    bucket_id = 'kyc-documents'
    AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
)
WITH CHECK (
    bucket_id = 'kyc-documents'
    AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
);

DROP POLICY IF EXISTS "kyc_documents_delete_own" ON storage.objects;
CREATE POLICY "kyc_documents_delete_own"
ON storage.objects
FOR DELETE
TO authenticated
USING (
    bucket_id = 'kyc-documents'
    AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
);

DO $$
DECLARE
    bucket_config RECORD;
    policy_count INTEGER;
BEGIN
    SELECT public, file_size_limit, allowed_mime_types
    INTO bucket_config
    FROM storage.buckets
    WHERE id = 'kyc-documents';

    IF NOT FOUND
       OR bucket_config.public IS DISTINCT FROM false
       OR bucket_config.file_size_limit IS DISTINCT FROM 5242880
       OR bucket_config.allowed_mime_types IS DISTINCT FROM
          ARRAY['image/jpeg', 'image/png', 'application/pdf'] THEN
        RAISE EXCEPTION 'kyc-documents bucket configuration is invalid';
    END IF;

    SELECT count(*)
    INTO policy_count
    FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename = 'objects'
      AND policyname IN (
          'kyc_documents_select_own',
          'kyc_documents_insert_own',
          'kyc_documents_update_own',
          'kyc_documents_delete_own'
      );

    IF policy_count <> 4 THEN
        RAISE EXCEPTION 'kyc-documents storage policies are incomplete';
    END IF;
END $$;

COMMIT;

-- Manual rollback (only after removing every object from the bucket):
--   DROP POLICY IF EXISTS "kyc_documents_select_own" ON storage.objects;
--   DROP POLICY IF EXISTS "kyc_documents_insert_own" ON storage.objects;
--   DROP POLICY IF EXISTS "kyc_documents_update_own" ON storage.objects;
--   DROP POLICY IF EXISTS "kyc_documents_delete_own" ON storage.objects;
--   DELETE FROM storage.buckets
--   WHERE id = 'kyc-documents'
--     AND NOT EXISTS (
--       SELECT 1 FROM storage.objects WHERE bucket_id = 'kyc-documents'
--     );
