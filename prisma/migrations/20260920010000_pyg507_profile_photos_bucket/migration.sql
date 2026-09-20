-- PYG-507 — bucket 'profile-photos' สำหรับรูปโปรไฟล์ที่อัปโหลดผ่าน backend (PYG-488)
--
-- ⚠ เขียนมือ ห้ามรัน prisma migrate dev / db push — Wasan รัน `prisma migrate deploy` เท่านั้น
--
-- สิ่งที่ไฟล์นี้ทำ: สร้าง/บังคับค่า private bucket 'profile-photos' (JPEG เท่านั้น, 5 MB)
--   ไม่แตะตาราง public ใด ๆ · ไม่มี backfill
--
-- ★ ไม่สร้าง policy บน storage.objects เลย (แพตเทิร์นเดียวกับ care-log-images ของ PYG-466):
--   เขียนด้วย service-role จาก backend เท่านั้น / อ่านผ่าน signed URL ที่ backend ออกให้หลังตรวจสิทธิ์
--   → anon/authenticated แตะไฟล์ตรง ๆ ไม่ได้
--
-- ★ ตั้งใจไม่ห่อ EXCEPTION: ถ้า role ที่รันไม่มีสิทธิ์บน storage.buckets ต้องล้มให้เห็น
--   ไม่งั้น migrate deploy ขึ้นเขียวแต่ bucket ไม่มี แล้ว endpoint อัปโหลดพังตอนใช้งานจริง
--
-- Dry-run (prod, 2026-09-20): SELECT id FROM storage.buckets WHERE id = 'profile-photos' → 0 แถว
--   bucket ที่มีอยู่: avatars (public!), care-log-images, job-evidence, kyc-documents
--   ⚠ 'avatars' เป็น bucket public ที่มีอยู่เดิม — รูปโปรไฟล์ที่ต้องผ่านรีวิว (PYG-488) ห้ามอยู่ที่นั่น
--     จึงสร้าง bucket ใหม่แทนการใช้ของเดิม (ดู PR สำหรับหนี้ที่ค้างเรื่อง bucket เก่า)
--
-- idempotent: ON CONFLICT DO UPDATE (ถ้ามีคนกดสร้างใน dashboard ไว้ก่อนด้วยค่าอื่น → บังคับกลับให้ตรงสเปก)
--
-- ROLLBACK (มือ):
--   DELETE FROM storage.buckets WHERE id = 'profile-photos'
--     AND NOT EXISTS (SELECT 1 FROM storage.objects WHERE bucket_id = 'profile-photos');
--     (ถ้า Supabase บล็อก DELETE ตรงบนตาราง storage → ล้างไฟล์แล้วลบ bucket ผ่าน Storage API)
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20260920010000_pyg507_profile_photos_bucket';

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('profile-photos', 'profile-photos', false, 5242880, ARRAY['image/jpeg'])
ON CONFLICT (id) DO UPDATE
    SET public             = EXCLUDED.public,
        file_size_limit    = EXCLUDED.file_size_limit,
        allowed_mime_types = EXCLUDED.allowed_mime_types;

DO $$
DECLARE
    is_public BOOLEAN;
BEGIN
    SELECT public INTO is_public FROM storage.buckets WHERE id = 'profile-photos';
    IF is_public IS DISTINCT FROM false THEN
        RAISE EXCEPTION 'PYG-507: bucket profile-photos ต้องเป็น private';
    END IF;
END $$;
