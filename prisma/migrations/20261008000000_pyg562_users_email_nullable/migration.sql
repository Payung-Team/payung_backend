-- PYG-602 — [DB] ให้ users.email เป็น nullable + บังคับว่าบัญชีต้องมีอีเมลหรือเบอร์อย่างน้อยหนึ่งอย่าง
--
-- การ์ดแม่: PYG-562 (S07 · ผู้ใช้ทุก role สมัครและล็อกอินด้วยเบอร์โทรศัพท์ที่ยืนยันแล้ว เพิ่มจากอีเมล)
--
-- ⚠ เขียนมือ ห้ามรัน prisma migrate dev / db push — Sammy gate และรัน `prisma migrate deploy` เท่านั้น
-- ⚠ ไฟล์นี้ต้อง merge "พร้อม" โค้ดของ PYG-603 ที่แก้จุดอ่าน users.email (37 จุด / 10 ไฟล์)
--   User.email ใน schema.prisma เปลี่ยนเป็น String? — ถ้า merge ไฟล์นี้เดี่ยว ๆ โค้ดจะ build ไม่ผ่าน
--
-- มติ 7 ต.ค. 2026 (Sammy): ยืนยันเบอร์ผ่าน Supabase Auth · ผู้ใช้เลือกสมัครด้วยอีเมลหรือเบอร์ก็ได้
--   ขอบเขตของการ์ดจึงเหลือเฉพาะไฟล์นี้:
--   • ไม่เพิ่ม users.phone_verified_at / unique index ของ users.phone
--     — สถานะยืนยันและ "1 เบอร์ 1 บัญชี" (S07-AC3) อยู่ที่ auth.users (phone_confirmed_at, UNIQUE (phone))
--   • ไม่สร้างตาราง phone_verifications — Supabase Auth สร้างและตรวจรหัสให้
--   • ไม่แปลง users.phone เป็น E.164 — โค้ดแปลงเป็น +66 ตอนส่งให้ Supabase
--     (เบอร์เดิม 28 แถวเป็น 0xxxxxxxxx และซ้ำกัน 4 กลุ่ม / 13 บัญชี — คงไว้ตามเดิม ไม่ถูกแตะ)
--
-- สิ่งที่ไฟล์นี้ทำ:
--   1) users.email DROP NOT NULL  (S07-AC1 — บัญชีที่สมัครด้วยเบอร์ไม่มีอีเมล)
--   2) CHECK users_email_or_phone_check — ต้องมี email หรือ phone ที่ "ไม่ว่าง" อย่างน้อยหนึ่งอย่าง (S07-R1)
--
-- ★ ต่างจาก SQL ที่การ์ดเสนอ 1 จุด: CHECK นับข้อความว่าง / ช่องว่างล้วนเป็น "ไม่มี"
--   การ์ดเสนอ CHECK (email IS NOT NULL OR phone IS NOT NULL) และตั้งข้อสังเกตเองว่า '' ผ่านได้ทั้งที่ไม่มีข้อมูลจริง
--   ข้อมูลปัจจุบันไม่มี email = '' หรือ phone = '' เลย (0 จาก 186) จึงเข้มได้โดยไม่กระทบแถวเดิม
--
-- ไม่แตะค่าในคอลัมน์ email / phone ของแถวเดิมสักแถว (S07-AC5)
-- unique index users_email_key (ไม่ใช่ partial) คงเดิม — Postgres ถือว่า NULL ไม่ซ้ำกัน หลายบัญชีไม่มีอีเมลได้
-- trigger on_google_auth_user_created (handle_new_google_user) insert NEW.email ตามเดิม — ไม่ต้องแก้
-- ไม่แตะ RLS (policy ของ users ไม่มีตัวใดอ้าง email)
--
-- idempotent: DROP NOT NULL รันซ้ำได้ · DROP CONSTRAINT IF EXISTS ก่อน ADD
--
-- แผนย้อนกลับ (มือ) — ★ ย้อนได้ตรง ๆ เฉพาะตอนที่ยังไม่มีบัญชีไม่มีอีเมล
--   1) SELECT count(*) FROM "users" WHERE "email" IS NULL;
--   2) ถ้าได้ 0:
--        ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_email_or_phone_check";
--        ALTER TABLE "users" ALTER COLUMN "email" SET NOT NULL;
--        DELETE FROM "_prisma_migrations" WHERE migration_name = '20261008000000_pyg562_users_email_nullable';
--      แล้ว revert PR โค้ดของ PYG-603 พร้อมกัน
--   3) ถ้ามากกว่า 0: SET NOT NULL จะล้ม และห้ามใส่อีเมลปลอมให้บัญชีเหล่านั้น
--      → ปิดการสมัครด้วยเบอร์ที่โค้ดก่อน คง email เป็น nullable ไว้ แล้วตัดสินรายบัญชี (ไม่มีทางย้อนอัตโนมัติ)


-- ─── 1. email ไม่บังคับ ────────────────────────────────────────────────────────
ALTER TABLE "users" ALTER COLUMN "email" DROP NOT NULL;

-- ─── 2. ต้องมีอีเมลหรือเบอร์อย่างน้อยหนึ่งอย่าง ────────────────────────────────
ALTER TABLE "users"
    DROP CONSTRAINT IF EXISTS "users_email_or_phone_check";
ALTER TABLE "users"
    ADD CONSTRAINT "users_email_or_phone_check"
        CHECK (
            NULLIF(btrim("email"), '') IS NOT NULL
            OR NULLIF(btrim("phone"), '') IS NOT NULL
        );

-- ─── 3. post-assertion: ผิดข้อใด migration ล้มทั้งไฟล์ ─────────────────────────
DO $$
DECLARE
    email_nullable TEXT;
    orphan_cnt     BIGINT;
BEGIN
    SELECT is_nullable INTO email_nullable FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'email';
    SELECT count(*) INTO orphan_cnt FROM "users"
     WHERE NULLIF(btrim("email"), '') IS NULL AND NULLIF(btrim("phone"), '') IS NULL;

    IF email_nullable <> 'YES' OR orphan_cnt <> 0 THEN
        RAISE EXCEPTION 'PYG-602: ตั้งค่าไม่ครบ (email_nullable=%, no_email_no_phone=%)',
            email_nullable, orphan_cnt;
    END IF;
END $$;
