-- ═══════════════════════════════════════════════════════════════════════════
-- Invariants ของ kyc_documents.file_url — รันใน CI ยิงใส่ staging
--   npm run check:kyc-paths
--
-- ทำไมต้องมีทั้งที่มี CHECK constraint แล้ว:
--   CHECK ตรวจ "รูปแบบ" ของค่าได้อย่างเดียว ตรวจ "ความเป็นเจ้าของ" ไม่ได้
--   เพราะต้อง join กับตาราง users ซึ่ง CHECK ทำไม่ได้ตามข้อจำกัดของ Postgres
--   ไฟล์นี้จึงรับหน้าที่ตรวจข้อที่ CHECK ตรวจไม่ได้
--
-- ออก exit code != 0 ถ้าเจอปัญหา (psql -v ON_ERROR_STOP=1)
-- ═══════════════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP on

DO $$
DECLARE
  full_urls    integer;
  traversal    integer;
  leading_slash integer;
  no_folder    integer;
  cross_user   integer;
  fixture_id   constant text := '87d7fa1c-caf2-4de5-ac0c-e4315a5c76b8';
BEGIN
  -- แถว fixture (example.com) ถูกยกเว้นทุกข้อ — จงใจเก็บไว้เป็นหลักฐานช่องโหว่
  SELECT
    count(*) FILTER (WHERE file_url LIKE '%://%'),
    count(*) FILTER (WHERE file_url LIKE '%..%'),
    count(*) FILTER (WHERE file_url LIKE '/%'),
    count(*) FILTER (WHERE file_url NOT LIKE '%/%')
  INTO full_urls, traversal, leading_slash, no_folder
  FROM kyc_documents
  WHERE id <> fixture_id;

  SELECT count(*) INTO cross_user
  FROM kyc_documents d
  JOIN users u ON u.id = d.user_id
  WHERE d.id <> fixture_id
    AND split_part(d.file_url, '/', 1) <> u.supabase_uid;

  RAISE NOTICE 'kyc_documents invariants: full_urls=% traversal=% leading_slash=% no_folder=% cross_user=%',
    full_urls, traversal, leading_slash, no_folder, cross_user;

  IF full_urls + traversal + leading_slash + no_folder + cross_user > 0 THEN
    RAISE EXCEPTION
      'kyc_documents.file_url ผิด invariant — full_urls=% traversal=% leading_slash=% no_folder=% cross_user=%',
      full_urls, traversal, leading_slash, no_folder, cross_user;
  END IF;
END $$;
