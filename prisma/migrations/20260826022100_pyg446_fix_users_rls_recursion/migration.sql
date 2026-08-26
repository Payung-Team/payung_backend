-- PYG-446: แก้ RLS infinite recursion (42P17) บน public.users
-- ═══════════════════════════════════════════════════════════════════════════
-- อาการ: caregiver อัป KYC ไม่ได้ — Storage ตอบ 503 DatabaseInvalidObjectDefinition
--        ("The database schema is invalid or incompatible.")
-- สาเหตุ (2 ชั้น):
--   [1] กับดักเดิมบน public.users — policy 3 ตัวเขียนแบบ EXISTS(SELECT FROM users)
--       คือต้องอ่าน users เพื่อตัดสินว่าอ่าน users ได้ไหม → recursion (latent)
--   [2] จุดชนวน = PYG-352 (commit c9cf79c, migration 20260803000000) เพิ่ม policy
--       job_evidence_select_participants บน storage.objects โดย subquery users
--       → ไปเหยียบกับดักชั้น [1]. storage.objects เป็นตารางร่วมของทุก bucket และ
--       SELECT policy ถูก OR รวมกัน → bucket kyc-documents พังไปด้วยทั้งที่ไม่เกี่ยว
--
-- วิธีแก้: ย้าย lookup ที่ต้องอ่าน users ไปไว้ใน SECURITY DEFINER function
--   (รันด้วยสิทธิ์ owner=postgres จึงไม่ถูก RLS ของ users ตรวจซ้ำ → ตัดลูป)
--   แล้วให้ policy เรียกฟังก์ชันแทน subquery ตัวเอง
--
-- ⚠ A และ B ต้องมาคู่กัน — ถ้าแก้เฉพาะ A (users) แต่ไม่แก้ B (storage) แล้ว
--   storage ก็ยังพังอยู่ (dry-check ยืนยันแล้วบน staging: A เดี่ยว → ยัง 42P17)
--
-- Pre-check (ยืนยันบน staging evsewucpighcbnhofmug แล้ว):
--   ✅ relforcerowsecurity ของ public.users = false  (ถ้าเป็น true วิธีนี้ใช้ไม่ได้)
--   ✅ owner ของ public.users = postgres            → ต้องรัน migration ด้วย role นี้
--
-- ทุก block ห่อ DO ... EXCEPTION ตาม convention ของ PYG-352:
--   บาง environment (local postgres ที่ไม่ใช่ Supabase) ไม่มี schema auth/storage
--   ถ้าไม่ห่อ migration จะล้มทั้งไฟล์ — ห่อไว้ให้ข้ามอย่างปลอดภัยพร้อม NOTICE
--
-- ⚠ ตั้งใจดักแค่ undefined_schema / undefined_table / undefined_function เท่านั้น
--   (เคส local ไม่มี auth/storage schema จริง) — ไม่ดัก insufficient_privilege
--   เพราะ fix นี้ "ต้อง" รันด้วย role postgres (owner ของ public.users) เท่านั้น
--   ถ้ารันด้วย role อื่น permission error ต้องทะลุขึ้นมา fail ทั้งไฟล์ ไม่งั้น
--   จะกลืน error เป็น NOTICE แล้วขึ้นเขียวเหมือนสำเร็จทั้งที่ recursion ยังอยู่
--   (fix fail เงียบ) — post-migration assertion ท้ายไฟล์เป็นด่านกันซ้ำอีกชั้น
-- ═══════════════════════════════════════════════════════════════════════════


-- ─── A1. helper: อ่าน role ของผู้เรียกโดยไม่ผ่าน RLS ของ users ─────────────────
DO $do$
BEGIN
    EXECUTE $ddl$
        CREATE OR REPLACE FUNCTION public.auth_user_role()
        RETURNS INT
        LANGUAGE sql
        STABLE
        SECURITY DEFINER
        SET search_path = pg_temp
        AS $fn$
            SELECT u.role
            FROM public.users u
            WHERE u.supabase_uid = (auth.uid())::text
              AND u.is_active = true
              AND u.is_deleted = false
            LIMIT 1;
        $fn$;
    $ddl$;

    -- ปิดสิทธิ์ default (PUBLIC) แล้วเปิดเฉพาะ authenticated
    EXECUTE 'REVOKE ALL ON FUNCTION public.auth_user_role() FROM PUBLIC';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.auth_user_role() TO authenticated';

    RAISE NOTICE 'PYG-446: สร้าง public.auth_user_role() (SECURITY DEFINER) เรียบร้อย';
EXCEPTION
    WHEN undefined_function OR undefined_schema OR undefined_table THEN
        RAISE NOTICE 'PYG-446: สร้าง auth_user_role() ไม่ได้ใน environment นี้ (ไม่มี auth/storage) — ข้าม';
END $do$;


-- ─── A2. เขียน policy ของ public.users ใหม่ ให้เรียกฟังก์ชันแทน subquery ตัวเอง ──
-- หมายเหตุ with_check ของ admin_update_users:
--   ไฟล์นี้ "คงพฤติกรรมเดิมเป๊ะ" — branch super-admin เช็คแค่ role = 4 (ไม่ดู
--   is_active/is_deleted) เหมือน policy เดิมทุกประการ ใช้ subquery ตรงเฉพาะใน
--   with_check ได้โดยไม่เกิด recursion เพราะเป็น WITH CHECK ของ UPDATE และ
--   SELECT policy ของ users ถูก de-recurse ไปแล้วใน A2 นี้
--   (การทำให้ with_check เข้มขึ้น = ดู is_active/is_deleted ด้วย เป็น SEMANTIC
--    CHANGE แยกไว้ migration ถัดไป 20260826022101 รอ sign-off)
DO $do$
BEGIN
    EXECUTE 'DROP POLICY IF EXISTS "admin_select_all_users" ON public.users';
    EXECUTE $pol$
        CREATE POLICY "admin_select_all_users" ON public.users
            FOR SELECT TO authenticated
            USING (public.auth_user_role() = ANY (ARRAY[3, 4]));
    $pol$;

    EXECUTE 'DROP POLICY IF EXISTS "admin_update_users" ON public.users';
    EXECUTE $pol$
        CREATE POLICY "admin_update_users" ON public.users
            FOR UPDATE TO authenticated
            USING (public.auth_user_role() = ANY (ARRAY[3, 4]))
            WITH CHECK (
                role = ANY (ARRAY[1, 2])
                OR EXISTS (
                    SELECT 1 FROM public.users u
                    WHERE u.supabase_uid = (auth.uid())::text
                      AND u.role = 4
                )
            );
    $pol$;

    EXECUTE 'DROP POLICY IF EXISTS "super_admin_full_access" ON public.users';
    EXECUTE $pol$
        CREATE POLICY "super_admin_full_access" ON public.users
            FOR ALL TO authenticated
            USING (public.auth_user_role() = 4)
            WITH CHECK (public.auth_user_role() = 4);
    $pol$;

    RAISE NOTICE 'PYG-446: เขียน policy public.users ใหม่ (admin_select/admin_update/super_admin) เรียบร้อย';
EXCEPTION
    WHEN undefined_function OR undefined_schema OR undefined_table THEN
        RAISE NOTICE 'PYG-446: ตั้ง policy public.users ไม่ได้ใน environment นี้ — ข้าม';
END $do$;


-- ─── B1. helper สำหรับ storage: อ่านสิทธิ์คู่กรณีของ booking โดยไม่ผ่าน RLS ─────
-- เงื่อนไขยกมาจาก PYG-352 ตรง ๆ (path convention = {bookingId}/{eventType}-{ts}.jpg
-- → segment แรกของ path คือ booking id) แต่ย้ายมาไว้ใน SECURITY DEFINER function
DO $do$
BEGIN
    EXECUTE $ddl$
        CREATE OR REPLACE FUNCTION public.job_evidence_can_read(object_name TEXT)
        RETURNS BOOLEAN
        LANGUAGE sql
        STABLE
        SECURITY DEFINER
        SET search_path = pg_temp
        AS $fn$
            SELECT EXISTS (
                SELECT 1
                FROM public.bookings b
                LEFT JOIN public.caregivers c ON c.id = b.caregiver_id
                WHERE (storage.foldername(object_name))[1] = (b.id)::text
                  AND ( b.patient_id IN (SELECT u.id FROM public.users u
                                         WHERE u.supabase_uid = (auth.uid())::text)
                     OR c.user_id    IN (SELECT u.id FROM public.users u
                                         WHERE u.supabase_uid = (auth.uid())::text) )
            );
        $fn$;
    $ddl$;

    EXECUTE 'REVOKE ALL ON FUNCTION public.job_evidence_can_read(TEXT) FROM PUBLIC';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.job_evidence_can_read(TEXT) TO authenticated';

    RAISE NOTICE 'PYG-446: สร้าง public.job_evidence_can_read() (SECURITY DEFINER) เรียบร้อย';
EXCEPTION
    WHEN undefined_function OR undefined_schema OR undefined_table THEN
        RAISE NOTICE 'PYG-446: สร้าง job_evidence_can_read() ไม่ได้ใน environment นี้ — ข้าม';
END $do$;


-- ─── B2. เขียน storage policy ของ PYG-352 ใหม่ ให้เรียกฟังก์ชันแทน subquery ────
DO $do$
BEGIN
    EXECUTE 'DROP POLICY IF EXISTS "job_evidence_select_participants" ON storage.objects';
    EXECUTE $pol$
        CREATE POLICY "job_evidence_select_participants" ON storage.objects
            FOR SELECT TO authenticated
            USING (
                bucket_id = 'job-evidence'
                AND public.job_evidence_can_read(name)
            );
    $pol$;

    RAISE NOTICE 'PYG-446: เขียน storage policy job_evidence_select_participants ใหม่เรียบร้อย';
EXCEPTION
    WHEN undefined_table OR undefined_function OR undefined_schema THEN
        RAISE NOTICE 'PYG-446: ตั้ง storage policy ไม่ได้ใน environment นี้ — ให้ Sam ตั้งด้วยมือ';
END $do$;

-- ─── POST-MIGRATION ASSERTION: ตรวจว่า fix "ลงจริง" ไม่ใช่แค่ "ไม่ error" ───────
-- ด่านกัน fix fail เงียบ: ต่อให้ทุก block ข้างบนไม่ error ก็ยังต้องพิสูจน์ว่า
--   (1) helper functions ทั้งสองตัวมีอยู่จริง
--   (2) admin_select_all_users เป็น definition ใหม่ (เรียก auth_user_role)
--       ไม่ใช่ตัวเดิมที่ recursive (EXISTS ... FROM users)
-- ถ้าเงื่อนไขไหนไม่ผ่าน → RAISE EXCEPTION (P0001, ไม่อยู่ใน guard) → fail ทั้งไฟล์
--
-- ครอบ guard undefined_schema/table/function เดียวกับ A/B: เริ่ม block ด้วยการ
-- แตะ auth + storage ก่อน — ถ้า environment ไม่มี schema เหล่านี้ (local ที่ fix
-- ถูกข้ามไปแล้ว) จะโยน undefined_schema/table แล้วถูก guard จับ → ข้าม assertion
-- พร้อมกับที่ fix ถูกข้าม (สอดคล้องกัน: ไม่มี fix ก็ไม่ assert)
DO $do$
DECLARE
    v_qual TEXT;
BEGIN
    -- ยามหน้าประตู: บังคับให้ environment ที่ไม่มี auth/storage ตกลง EXCEPTION guard
    PERFORM auth.uid();                       -- ไม่มี schema auth → undefined_schema/function
    PERFORM 'storage.objects'::regclass;      -- ไม่มี schema storage → undefined_table

    -- (1) helper functions ต้องมีจริง
    IF to_regprocedure('public.auth_user_role()') IS NULL THEN
        RAISE EXCEPTION 'PYG-446 assertion FAIL: public.auth_user_role() ไม่มีอยู่หลัง migration';
    END IF;
    IF to_regprocedure('public.job_evidence_can_read(text)') IS NULL THEN
        RAISE EXCEPTION 'PYG-446 assertion FAIL: public.job_evidence_can_read(TEXT) ไม่มีอยู่หลัง migration';
    END IF;

    -- (2) admin_select_all_users ต้องเป็น definition ใหม่ (เรียก auth_user_role)
    SELECT qual INTO v_qual
    FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'users'
      AND policyname = 'admin_select_all_users';

    IF v_qual IS NULL THEN
        RAISE EXCEPTION 'PYG-446 assertion FAIL: ไม่พบ policy admin_select_all_users';
    END IF;
    IF v_qual NOT ILIKE '%auth_user_role%' THEN
        RAISE EXCEPTION 'PYG-446 assertion FAIL: admin_select_all_users ไม่ได้เรียก auth_user_role() (qual=%)', v_qual;
    END IF;
    IF v_qual ~* 'from\s+users' THEN
        RAISE EXCEPTION 'PYG-446 assertion FAIL: admin_select_all_users ยังเป็น definition เดิมที่ recursive (qual=%)', v_qual;
    END IF;

    RAISE NOTICE 'PYG-446: post-migration assertion ผ่าน — functions + policy ลงจริง (recursion fix ยืนยันแล้ว)';
EXCEPTION
    WHEN undefined_function OR undefined_schema OR undefined_table THEN
        RAISE NOTICE 'PYG-446: ข้าม assertion ใน environment นี้ (ไม่มี auth/storage) — สอดคล้องกับที่ fix ถูกข้าม';
END $do$;


-- ── หมายเหตุท้ายไฟล์ ─────────────────────────────────────────────────────────
-- • B2: policy เดิมของ PYG-352 มี roles = {public}; ไฟล์นี้เปลี่ยนเป็น TO authenticated
--   ให้ตรงกับความจริงว่า job-evidence เป็น private bucket (อ่านผ่าน signed URL,
--   ต้อง login) — anon ไม่ควรอ่านได้อยู่แล้ว จึงไม่เสียสิทธิ์ที่ควรมี
-- • A + B ต้อง deploy พร้อมกัน (ไฟล์เดียวกัน) — แยกกันเมื่อไร storage พังทันที
-- • debt ที่ยังไม่แตะในรอบนี้ (แยก follow-up ticket): policy ของ bucket
--   kyc-documents + avatars (~10 object กดมือใน dashboard, ไม่มีใน git)
