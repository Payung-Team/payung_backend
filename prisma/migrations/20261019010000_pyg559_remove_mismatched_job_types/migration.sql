-- PYG-591 (S04 · PYG-559 AC6): นำแถว physiotherapy ใน caregiver_job_types ที่ไม่ผ่านกฎวิชาชีพ + ใบประกอบฯ ออก
--
-- ⚠ เขียนมือ ห้ามรัน prisma migrate dev / db push — Sammy gate และรัน `prisma migrate deploy` เท่านั้น
-- ⚠ ลบข้อมูล: สำเนาทุกแถวที่ลบไว้ใน caregiver_job_types_removed_pyg559 ก่อนลบ (กู้คืนได้ — ดู ROLLBACK)
--
-- กฎ (PYG-590 เคาะ 7 ต.ค. 2026): ผูกวิชาชีพเฉพาะ physiotherapy → profession = 'physiotherapist'
--   และมีใบประกอบฯ (doc_type 'professional_license') ที่ approved และยังไม่หมดอายุ
--   medication / general_care / bedridden_care / companion ไม่แตะ
--
-- ต่างจาก SQL ร่างในการ์ด:
--   1. จับคู่ใบประกอบฯ ทั้ง caregiver_id และ user_id (kyc_documents.caregiver_id เป็น NULL ได้)
--   2. เปิด RLS บนตารางสำเนา (CREATE TABLE AS ไม่สืบทอด — ไม่เปิด = PostgREST อ่าน/เขียนได้)
--   3. PRIMARY KEY บนตารางสำเนา (prisma db pull ไม่ข้ามตาราง)
--   4. ลบด้วย id ของแถวที่สำเนาไว้เท่านั้น
--
-- GUARD: ทบทวน 18–19 ต.ค. 2026 = 11 แถว (physiotherapy ล้วน, ผู้ดูแล 11 คน)
-- ฐานข้อมูลใหม่ที่ยังไม่มีผู้ดูแลต้องได้ 0 แถว; ค่าอื่นหมายถึงข้อมูลเปลี่ยนและต้องหยุดทบทวน
--   (ข้อมูลเปลี่ยนระหว่างทบทวนกับรัน → หยุดและทบทวนใหม่ แล้วแก้เลขในไฟล์นี้ก่อน deploy)
--   ทั้งไฟล์รันเป็น transaction เดียว — ล้มตรงไหนไม่มีอะไรค้าง
--
-- หลัง deploy: cron JobTypeRemovalNotifier (PYG-592 · ทุกชั่วโมงนาทีที่ 10) แจ้งผู้ดูแลในตารางสำเนา 1 ฉบับต่อคน
--
-- ROLLBACK (มือ · กู้แถวคืน แล้วลบตารางสำเนา):
--   INSERT INTO "caregiver_job_types" (id, caregiver_id, job_type, created_at)
--     SELECT id, caregiver_id, job_type, created_at FROM "caregiver_job_types_removed_pyg559"
--     ON CONFLICT DO NOTHING;
--   DROP TABLE "caregiver_job_types_removed_pyg559";
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261019010000_pyg559_remove_mismatched_job_types';
--   (แจ้งเตือนที่ส่งไปแล้วไม่ถูกถอน)

CREATE TABLE "caregiver_job_types_removed_pyg559" AS
SELECT cjt.*, c.profession AS profession_at_removal, now() AS removed_at
  FROM "caregiver_job_types" cjt
  JOIN "caregivers" c ON c.id = cjt.caregiver_id
 WHERE cjt.job_type = 'physiotherapy'
   AND NOT (c.profession = 'physiotherapist' AND EXISTS (
            SELECT 1 FROM "kyc_documents" d
             WHERE (d.caregiver_id = c.id OR d.user_id = c.user_id)
               AND d.doc_type = 'professional_license'
               AND d.review_status = 'approved'
               AND d.expires_at > now()));

DO $guard$
DECLARE
  expected CONSTANT int := 11;
  n int;
  n_other int;
BEGIN
  SELECT count(*), count(*) FILTER (WHERE job_type <> 'physiotherapy') INTO n, n_other
    FROM "caregiver_job_types_removed_pyg559";
  IF n NOT IN (0, expected) OR n_other <> 0 THEN
    RAISE EXCEPTION 'PYG-591 guard: จะนำออก % แถว (ไม่ใช่ physiotherapy % แถว) แต่ยืนยันไว้ % แถว — หยุด ทบทวนใหม่', n, n_other, expected;
  END IF;
END
$guard$;

ALTER TABLE "caregiver_job_types_removed_pyg559"
    ADD CONSTRAINT "caregiver_job_types_removed_pyg559_pkey" PRIMARY KEY ("id");
ALTER TABLE "caregiver_job_types_removed_pyg559" ENABLE ROW LEVEL SECURITY;

DELETE FROM "caregiver_job_types" cjt
 USING "caregiver_job_types_removed_pyg559" r
 WHERE cjt.id = r.id;

DO $post$
DECLARE n_left int;
BEGIN
  SELECT count(*) INTO n_left
    FROM "caregiver_job_types" cjt
    JOIN "caregivers" c ON c.id = cjt.caregiver_id
   WHERE cjt.job_type = 'physiotherapy' AND c.profession <> 'physiotherapist';
  IF n_left <> 0 THEN
    RAISE EXCEPTION 'PYG-591 post-check: ยังเหลือ physiotherapy ที่วิชาชีพไม่ตรง % แถว', n_left;
  END IF;
END
$post$;
