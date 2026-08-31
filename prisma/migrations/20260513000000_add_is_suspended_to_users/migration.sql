-- Migration: PYG-132 — เพิ่ม column is_suspended ในตาราง users
--
-- วัตถุประสงค์:
-- - is_suspended: ใช้เมื่อ admin ต้องการระงับบัญชี (ban user)
-- - แยกจาก is_active เพราะคนละความหมาย:
--     is_active     = account ใช้งานได้ปกติไหม (เช่น ยังไม่ confirm email = false)
--     is_suspended  = admin สั่งระงับชั่วคราว/ถาวร (PYG-132)
--
-- Default = false (user ใหม่ทุกคนใช้งานปกติ ยังไม่โดน suspend)
-- SupabaseAuthGuard จะ throw 403 ForbiddenException ถ้า field นี้ = true

ALTER TABLE "users"
  ADD COLUMN "is_suspended" BOOLEAN NOT NULL DEFAULT false;
