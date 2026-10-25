-- PYG-714: ประวัติการส่งอีเมล (email_logs) — ทีมตรวจได้ว่าทำไมผู้ใช้ไม่ได้อีเมล
--
-- ⚠ เขียนมือ ห้ามรัน prisma migrate dev / db push — Sammy gate และรัน `prisma migrate deploy` เท่านั้น
-- เพิ่มตารางใหม่อย่างเดียว ไม่แตะข้อมูลเดิม · ทั้งไฟล์รันเป็น transaction เดียว
--
-- ★ ไม่เก็บอีเมลเต็มและเนื้อหาอีเมล (อีเมลเชิญแอดมินมีรหัสผ่านชั่วคราว) — user_id + recipient_masked พอ
-- ★ user_id ON DELETE SET NULL: cron ลบบัญชี (user-cleanup) ลบผู้ใช้แล้วประวัติการส่งยังอยู่
-- ★ เปิด RLS ไม่มี policy = PostgREST (anon/authenticated) อ่าน/เขียนไม่ได้ · BE ต่อด้วย role เจ้าของตารางจึงไม่ติด
--
-- ROLLBACK (มือ):
--   DROP TABLE "email_logs";
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261025000000_pyg714_email_logs';
--   (โค้ดที่เขียน email_logs จับ error เอง — ตารางหายแล้วการส่งอีเมลยังทำงาน แค่ไม่มีประวัติ)

CREATE TABLE "email_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" TEXT,
    "recipient_masked" VARCHAR(320),
    "template" VARCHAR(64) NOT NULL,
    "subject" TEXT,
    "status" VARCHAR(16) NOT NULL,
    "reason" TEXT,
    "provider" VARCHAR(32),
    "provider_message_id" VARCHAR(128),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "idx_email_logs_user_created" ON "email_logs"("user_id", "created_at" DESC);

CREATE INDEX "idx_email_logs_status_created" ON "email_logs"("status", "created_at" DESC);

ALTER TABLE "email_logs" ADD CONSTRAINT "email_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "email_logs" ENABLE ROW LEVEL SECURITY;
