-- PYG-508 — แอดมินอนุมัติ / ปฏิเสธรูปโปรไฟล์ผู้ดูแล (การ์ดแม่ PYG-488)
--
-- ⚠ เขียนมือ ห้ามรัน prisma migrate dev / db push — Wasan รัน `prisma migrate deploy` เท่านั้น
--
-- สิ่งที่ไฟล์นี้ทำ: NotificationType เพิ่ม 'profile_photo_approved' / 'profile_photo_rejected'
--   (แยกจาก kyc_verified / kyc_rejected — FE พา kyc_* ไปหน้า /kyc/status ซึ่งไม่ใช่ที่ของรูปโปรไฟล์)
--   ไม่แตะตาราง / ไม่สร้าง bucket — รูปที่อนุมัติแล้วอยู่ใน 'profile-photos' เดิม (PYG-507)
--   approveProfilePhoto แค่ตั้ง users.avatar_url เป็น path ของใบนั้น
--
-- idempotent: ADD VALUE IF NOT EXISTS
--
-- ROLLBACK (มือ):
--   ค่าใน enum NotificationType ลบไม่ได้ใน Postgres — ปล่อยไว้ไม่มีผลกับของเดิม
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261003000000_pyg508_profile_photo_review';

ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'profile_photo_approved';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'profile_photo_rejected';
