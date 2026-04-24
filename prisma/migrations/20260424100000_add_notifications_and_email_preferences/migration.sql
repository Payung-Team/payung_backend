-- PYG-95: Add notifications table + email_preferences column
--
-- Changes:
-- 1. Create NotificationType enum (kyc_submitted | kyc_verified | kyc_rejected | kyc_resubmitted)
-- 2. Create notifications table with composite index
-- 3. Add email_preferences column to users (default true)
-- 4. Enable RLS + policies: users อ่าน/แก้ได้เฉพาะ notification ของตัวเอง

-- ─── 1. CreateEnum NotificationType ───────────────────────────────────────────
CREATE TYPE "NotificationType" AS ENUM ('kyc_submitted', 'kyc_verified', 'kyc_rejected', 'kyc_resubmitted');

-- ─── 2. AlterTable users: เพิ่ม email_preferences ─────────────────────────────
ALTER TABLE "users" ADD COLUMN "email_preferences" BOOLEAN NOT NULL DEFAULT true;

-- ─── 3. CreateTable notifications ─────────────────────────────────────────────
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "data" JSONB,
    "is_read" BOOLEAN NOT NULL DEFAULT false,
    "read_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- ─── 4. CreateIndex: composite index สำหรับ query ยอดนิยม ─────────────────────
-- (user_id, is_read, created_at DESC) → filter ของตัวเอง + unreadOnly + sort
CREATE INDEX "notifications_user_id_is_read_created_at_idx"
    ON "notifications"("user_id", "is_read", "created_at" DESC);

-- ─── 5. AddForeignKey ─────────────────────────────────────────────────────────
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── 6. Enable RLS (Row Level Security) ───────────────────────────────────────
-- RLS ทำให้ query จาก Supabase client เห็นเฉพาะ row ที่ตรง policy
-- Backend (ที่ใช้ service_role key) จะ bypass RLS ได้ — RLS คุ้มครองเฉพาะ client-side
ALTER TABLE "notifications" ENABLE ROW LEVEL SECURITY;

-- Policy 1: SELECT — user อ่านได้เฉพาะ notification ของตัวเอง
-- auth.uid() = Supabase Auth user id (supabase_uid ในตาราง users ของเรา)
-- users.id = internal UUID ที่ใช้เป็น user_id ใน notifications
-- ต้อง JOIN เพื่อเช็คว่า user_id ของ notification match กับ auth.uid()
CREATE POLICY "notifications_select_own" ON "notifications"
    FOR SELECT
    USING (
        user_id IN (
            SELECT id FROM users WHERE supabase_uid = auth.uid()::text
        )
    );

-- Policy 2: UPDATE — user แก้ไขได้เฉพาะ notification ของตัวเอง (markAsRead)
CREATE POLICY "notifications_update_own" ON "notifications"
    FOR UPDATE
    USING (
        user_id IN (
            SELECT id FROM users WHERE supabase_uid = auth.uid()::text
        )
    );

-- Policy 3: INSERT — backend เท่านั้นที่ insert (ผ่าน service_role)
-- ไม่สร้าง policy INSERT สำหรับ user → client ปกติ insert ไม่ได้
-- Policy 4: DELETE — ไม่อนุญาตให้ user ลบเอง (กันการแก้ไขประวัติ)
