-- NotificationType: เพิ่มค่า job_care_log_added (แจ้งเตือนเมื่อมีการบันทึก care log)
--
-- ⚠ เขียนมือ ห้ามรัน prisma migrate dev / db push — Wasan รัน `prisma migrate deploy` เท่านั้น
--
-- ADD-only: เพิ่มค่าแต่ไม่ได้ "ใช้" ค่านี้ใน migration เดียวกัน จึงปลอดภัยใน transaction ของ migration (PG15)
-- แพทเทิร์นเดียวกับ 20260814023743_add_job_checked_in_notification_type (PYG-353)
--
-- ROLLBACK: ไม่มีทาง DROP ค่าออกจาก enum ใน Postgres ได้ตรง ๆ
--   ถ้าต้องถอนจริงต้องสร้าง type ใหม่แล้ว ALTER COLUMN ... TYPE ... USING — อย่าทำแบบลวก ๆ
--   ค่า enum ที่ไม่มีใครใช้ไม่มีผลเสียใด ๆ ปล่อยไว้ได้

ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'job_care_log_added';
