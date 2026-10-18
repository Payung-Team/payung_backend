-- NotificationType เพิ่ม 6 ค่าที่โค้ดใน PR #132 (PYG-549 / PYG-587 / PYG-592) ใช้แต่ DB ยังไม่มี
--
-- ⚠ เขียนมือ ห้ามรัน prisma migrate dev / db push — Sammy gate และรัน `prisma migrate deploy` เท่านั้น
--
-- ที่มา: #132 เพิ่ม payout_account_* ใน schema.prisma โดยไม่มี migration และใช้ license_* / job_type_removed
--   ใน src/notification/entities/notification-type.enum.ts โดยไม่มีทั้งใน schema.prisma และ DB
--   → notification create ล้ม (log อย่างเดียว) ผู้ดูแลไม่ได้รับแจ้ง
--
--   payout_account_verified / payout_account_failed  — PYG-549: ผลตรวจบัญชีรับเงินจาก Omise
--   license_approved / license_rejected / license_expired — PYG-587: ผลตรวจ / หมดอายุใบประกอบวิชาชีพ
--   job_type_removed                                    — PYG-592 / PYG-591: ประเภทงานเดิมถูกนำออก (S04-AC6)
--
-- ไม่แตะตาราง ไม่แตะข้อมูล — เพิ่มค่า enum อย่างเดียว · ขึ้นก่อน #132 ได้ (โค้ดเดิมไม่ใช้ค่าเหล่านี้)
--
-- idempotent: ADD VALUE IF NOT EXISTS
--
-- ROLLBACK (มือ):
--   ค่าใน enum ลบไม่ได้ใน Postgres — ปล่อยไว้ไม่มีผลกับของเดิม (แบบเดียวกับ 20261003000000_pyg508)
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261018000000_notification_type_license_payout_job_type';

ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'payout_account_verified';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'payout_account_failed';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'license_approved';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'license_rejected';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'license_expired';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'job_type_removed';
