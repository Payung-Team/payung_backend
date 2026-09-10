-- PYG-460 — ข้อมูลผู้รับบริการที่กรอกตอนจอง ไม่มี DB รองรับจริง
--
-- ตาราง care_recipients มีคอลัมน์สุขภาพเกือบครบอยู่แล้ว (date_of_birth, gender,
-- weight_kg, height_cm, mobility_level, medical_conditions[], current_medications,
-- allergies, blood_type, preferred_hospital) migration นี้จึงเติมเฉพาะ "ส่วนที่ขาด"
-- ไม่ใช่สร้างของใหม่ทั้งชุด
--
-- ① care_notes — "คำแนะนำการดูแล" ในฟอร์ม FE เป็นช่องเดียวในฟอร์มที่ไม่มีคอลัมน์
--   รองรับเลย (การ์ดเคลมว่า "ไม่ต้องทำ migration" ตกช่องนี้ไป)
--   ตัวอย่างค่าจริง: "เดินต้องมีคนพยุงข้างซ้ายเสมอ ลุกจากเตียงช้า ๆ เพราะเวียนหัวง่าย"
--   → TEXT ไม่ใช่ VARCHAR เพราะเป็นความเรียงที่ไม่มีเพดานตามธรรมชาติ
--
-- ② is_deleted / deleted_at — FE มีปุ่มลบโปรไฟล์พร้อม modal ยืนยันอยู่แล้ว
--   (BookingStepPatient.tsx: confirmDeleteRecipient) แต่ยังลบแค่ใน state
--   เพราะไม่มี endpoint รองรับ
--
--   ★ ทำไมต้อง soft delete ไม่ใช่ DELETE จริง:
--     bookings.care_recipient_id เป็น FK แบบ ON DELETE SET NULL → ลบโปรไฟล์จริง
--     เมื่อไหร่ ประวัติการจองทุกใบที่เคยผูกกับคนไข้คนนั้นจะขาดการเชื่อมโยงทันที
--     และเป็นการขาดแบบเงียบ ๆ ที่ย้อนกลับไม่ได้ ทั้งที่ข้อมูลการแพทย์ของงานที่
--     "ทำไปแล้ว" คือหลักฐานว่าผู้ดูแลได้รับแจ้งอะไรบ้าง ณ วันนั้น
--     ใช้ชื่อคอลัมน์ชุดเดียวกับ users (is_deleted + deleted_at) เพื่อให้
--     admin cleanup ในอนาคตอ่านรูปแบบเดียวกันได้ทั้งระบบ
--
-- migration นี้เป็น additive ทั้งหมด: ไม่มี DROP, ไม่มี ALTER TYPE, ไม่แตะข้อมูลเดิม
-- แถวเก่าทุกแถวได้ care_notes = NULL และ is_deleted = FALSE ซึ่งตรงกับพฤติกรรมวันนี้

ALTER TABLE "care_recipients" ADD COLUMN IF NOT EXISTS "care_notes" TEXT;
ALTER TABLE "care_recipients" ADD COLUMN IF NOT EXISTS "is_deleted" BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE "care_recipients" ADD COLUMN IF NOT EXISTS "deleted_at" TIMESTAMPTZ(6);

-- list() กรอง is_deleted = FALSE ทุกครั้ง และ 99% ของแถวจะเป็น FALSE
-- → partial index บนฝั่ง "ยังไม่ถูกลบ" คุ้มกว่า index เต็มคอลัมน์ boolean
CREATE INDEX IF NOT EXISTS "idx_care_recipients_active"
  ON "care_recipients" ("patient_id")
  WHERE "is_deleted" = FALSE;

-- ─── ROLLBACK ────────────────────────────────────────────────────────────────
-- ปลอดภัยเต็มที่ก็ต่อเมื่อยังไม่มีโค้ดเวอร์ชันใหม่วิ่งอยู่ (ไม่งั้น service จะ
-- select คอลัมน์ที่หายไป) ลำดับที่ถูกคือ rollback แอปก่อน แล้วค่อยรัน SQL นี้
-- ⚠ DROP COLUMN care_notes = ทิ้ง "คำแนะนำการดูแล" ที่ผู้ใช้กรอกไว้ถาวร
--   ถ้ามีแถวที่ care_notes IS NOT NULL แล้ว ให้ dump ออกก่อน
--
--   DROP INDEX IF EXISTS "idx_care_recipients_active";
--   ALTER TABLE "care_recipients" DROP COLUMN IF EXISTS "deleted_at";
--   ALTER TABLE "care_recipients" DROP COLUMN IF EXISTS "is_deleted";
--   ALTER TABLE "care_recipients" DROP COLUMN IF EXISTS "care_notes";
