-- PYG-434 — [BE] Generate QR/token ตอนสร้าง booking
--
-- การ์ดแม่: PYG-433 (QR check-in/out for caregiver jobs)
-- Epic:     PYG-350 (Proof-of-Work Monitoring — Check-in / Check-out & GPS)
--
-- ⚠ ไฟล์นี้ "เขียนมือ" ตามกติกาของทีม — ห้ามรัน prisma migrate dev / db push
--   คนเดียวที่รัน `prisma migrate deploy` คือ Sam เท่านั้น
--   หลัง deploy ให้เช็คว่า `prisma db pull` ไม่มี diff (schema.prisma sync ด้วยมือแล้ว)
--
-- ─────────────────────────────────────────────────────────────────────────────
-- ★ ขอบเขตของไฟล์นี้ — อ่านก่อน review
--
--   ไฟล์นี้สร้าง "แค่ตาราง job_sessions" ตัวเดียว
--   ตาราง job_scan_events (บันทึกทุกครั้งที่มีการสแกน สำเร็จ+ล้มเหลว) เป็นของ PYG-436
--   ซึ่งจะออกเป็น migration แยกอีกไฟล์ ไม่ต้องแก้ไฟล์นี้
--
--   เหตุผลที่ต้องมีตารางนี้มาก่อน: PYG-434 คือ "สร้าง QR ตอนจอง" ถ้าไม่มีตาราง
--   โค้ดฝั่ง TypeScript จะ compile ไม่ผ่านเลย (prisma.jobSession ไม่มีอยู่จริง)
-- ─────────────────────────────────────────────────────────────────────────────
--
-- ★★ สิ่งที่ต้องเข้าใจก่อนแตะตารางนี้ ★★
--   คอลัมน์ token_hash เก็บ sha256(token) เป็น hex 64 ตัวเท่านั้น
--   "token ตัวจริงไม่เคยถูกเขียนลงดีบี" — มันถูกคำนวณใหม่ทุกครั้งที่ patient เปิดดู QR
--   จาก QR_TOKEN_SECRET (อยู่ใน ENV ของเซิร์ฟเวอร์) + id ของแถวนี้
--   → ดัมพ์ดีบีไปทั้งก้อนก็ปลอม QR ไม่ได้ เพราะ secret ไม่ได้อยู่ในดีบี
--   รายละเอียดวิธีคำนวณ: src/monitoring/qr/job-qr.service.ts
--
-- หมายเหตุชนิดข้อมูล (อย่าเดา — ของจริงในดีบีเป็นแบบนี้):
--   bookings.id = UUID  → booking_id ในไฟล์นี้จึงเป็น UUID ตาม
--   (ต่างจาก users.id ที่เป็น TEXT — ตารางนี้ไม่ได้ชี้ไป users เลย จึงไม่เกี่ยว)


-- ═══════════════════════════════════════════════════════════════════════════
-- 1. TABLE
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "job_sessions" (
    "id"         UUID NOT NULL DEFAULT gen_random_uuid(),

    -- 1 booking = 1 ใบ QR (unique index อยู่ข้อ 2.1)
    -- ON DELETE CASCADE: ลบ booking ทิ้ง ใบ QR ก็ต้องหายตาม ไม่มีความหมายเหลืออยู่
    -- (แพตเทิร์นเดียวกับ job_events — จริง ๆ ระบบไม่เคยลบ booking ทิ้ง
    --  มีแต่เปลี่ยน status เป็น 'cancelled' ซึ่งไม่ทำให้แถวนี้หาย)
    "booking_id" UUID NOT NULL,

    -- ★ sha256(token) hex 64 ตัว — CHECK ด้านล่างกันเผลอเขียน token ดิบลงมา
    --   ถ้าวันหนึ่งมีใครแก้โค้ดให้ INSERT token ดิบ ดีบีจะปฏิเสธทันที
    --   (token ดิบของเราเป็น base64url 43 ตัว ซึ่งยาวไม่เท่า 64 → ติด CHECK แน่นอน)
    "token_hash" TEXT NOT NULL,

    -- 'PENDING' → 'CHECKED_IN' → 'CHECKED_OUT' (เดินหน้าทางเดียว)
    -- ไม่มี 'CANCELLED' โดยตั้งใจ — ความจริงเรื่อง "งานถูกยกเลิก" อยู่ที่ bookings.status
    -- ที่เดียว ถ้าคัดลอกมาไว้สองที่ วันหนึ่งมันจะไม่ตรงกันแล้ว QR ที่ควรตายจะยังใช้ได้
    "status"     TEXT NOT NULL DEFAULT 'PENDING',

    -- ช่วงเวลาที่ QR ใบนี้ใช้ได้ — คำนวณตอนสร้างจากตารางงานของ booking
    --   valid_from  = เวลานัดเริ่ม − QR_VALID_FROM_OFFSET_MIN  (มาก่อนเวลาได้)
    --   valid_until = เวลานัดจบ   + QR_VALID_UNTIL_GRACE_MIN   (เลิกงานช้าได้)
    "valid_from"     TIMESTAMPTZ(6) NOT NULL,
    "valid_until"    TIMESTAMPTZ(6) NOT NULL,

    -- NULL = ยังไม่เกิดขึ้น. PYG-435 (scan) เป็นคนเขียนสองคอลัมน์นี้ ไม่ใช่การ์ดนี้
    "checked_in_at"  TIMESTAMPTZ(6),
    "checked_out_at" TIMESTAMPTZ(6),

    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "job_sessions_pkey" PRIMARY KEY ("id")
);

-- ─── FK ไป bookings ────────────────────────────────────────────────────────
-- ห่อ DO block เพราะ ADD CONSTRAINT ไม่มี IF NOT EXISTS
DO $$ BEGIN
    ALTER TABLE "job_sessions"
        ADD CONSTRAINT "job_sessions_booking_id_fkey"
        FOREIGN KEY ("booking_id") REFERENCES "bookings"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN
    RAISE NOTICE 'PYG-434: FK job_sessions_booking_id_fkey มีอยู่แล้ว — ข้าม';
END $$;

-- ─── CHECK: status ต้องเป็นค่าที่รู้จักเท่านั้น ─────────────────────────────
-- ค่าพวกนี้ต้องตรงกับ JOB_SESSION_STATUS ใน src/monitoring/qr/qr.constants.ts เป๊ะ ๆ
-- ถ้าจะเพิ่มค่าใหม่ ต้องแก้ทั้งสองที่พร้อมกันเสมอ ไม่งั้น INSERT จะพังตอน runtime
DO $$ BEGIN
    ALTER TABLE "job_sessions"
        ADD CONSTRAINT "job_sessions_status_check"
        CHECK ("status" IN ('PENDING', 'CHECKED_IN', 'CHECKED_OUT'));
EXCEPTION WHEN duplicate_object THEN
    RAISE NOTICE 'PYG-434: CHECK job_sessions_status_check มีอยู่แล้ว — ข้าม';
END $$;

-- ─── CHECK: token_hash ต้องเป็น sha256 hex เท่านั้น ────────────────────────
-- ★ ด่านสุดท้ายที่กันไม่ให้ token ดิบหลุดลงดีบี แม้โค้ดฝั่ง app จะเขียนผิด
DO $$ BEGIN
    ALTER TABLE "job_sessions"
        ADD CONSTRAINT "job_sessions_token_hash_check"
        CHECK ("token_hash" ~ '^[0-9a-f]{64}$');
EXCEPTION WHEN duplicate_object THEN
    RAISE NOTICE 'PYG-434: CHECK job_sessions_token_hash_check มีอยู่แล้ว — ข้าม';
END $$;

-- ─── CHECK: ช่วงเวลาต้องไม่กลับหัว ─────────────────────────────────────────
DO $$ BEGIN
    ALTER TABLE "job_sessions"
        ADD CONSTRAINT "job_sessions_valid_window_check"
        CHECK ("valid_until" > "valid_from");
EXCEPTION WHEN duplicate_object THEN
    RAISE NOTICE 'PYG-434: CHECK job_sessions_valid_window_check มีอยู่แล้ว — ข้าม';
END $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- 2. INDEXES
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 2.1 หนึ่ง booking ได้ QR ใบเดียว ──────────────────────────────────────
-- นี่คือ invariant ของทั้งฟีเจอร์ ("QR ใบเดียวต่อ booking" ในการ์ด PYG-433)
-- บังคับที่ดีบี ไม่ใช่แค่ที่โค้ด เพราะถ้าสองรีเควสต์สร้าง booking ชนกัน
-- การเช็คในโค้ดอย่างเดียวจะปล่อยให้เกิดสองแถวได้
CREATE UNIQUE INDEX IF NOT EXISTS "job_sessions_booking_id_key"
    ON "job_sessions" ("booking_id");

-- ─── 2.2 ค้นหา session จาก token ที่สแกนมา (PYG-435) ───────────────────────
-- scanJobQr(token) → sha256(token) → หาแถวนี้ ต้องเร็วและต้องไม่ซ้ำ
CREATE UNIQUE INDEX IF NOT EXISTS "job_sessions_token_hash_key"
    ON "job_sessions" ("token_hash");

-- ─── 2.3 กวาดหา session ที่ยังไม่ปิดและหมดอายุแล้ว ─────────────────────────
-- เตรียมไว้ให้ cron ของ PYG-359 / รายงานฝั่งแอดมิน — ยังไม่มีใครใช้ในการ์ดนี้
CREATE INDEX IF NOT EXISTS "job_sessions_status_valid_until_idx"
    ON "job_sessions" ("status", "valid_until");


-- ═══════════════════════════════════════════════════════════════════════════
-- 3. ROW LEVEL SECURITY
-- ═══════════════════════════════════════════════════════════════════════════
-- ★ เปิด RLS แต่ "ไม่สร้าง policy เลย" — ตั้งใจ 100%
--
--   RLS เปิดแล้วไม่มี policy = ปฏิเสธทุกแถวสำหรับทุก role ที่ไม่ใช่เจ้าของตาราง
--   แปลว่า client ที่ถือ anon key ยิงตรงเข้า Supabase อ่านตารางนี้ไม่ได้เลยแม้แต่แถวเดียว
--
--   ทำไมต้องเข้มขนาดนี้: ตารางนี้เก็บ token_hash ถ้าปล่อยให้อ่านได้
--   = แจกลายนิ้วมือของ QR ออกไปฟรี ๆ ให้เอาไปเทียบแบบ offline
--   การอ่าน QR ต้องผ่าน resolver jobQr() ของ PYG-434 เท่านั้น ซึ่งตรวจว่า
--   ผู้เรียกเป็น patient เจ้าของ booking ใบนั้นจริง แล้วค่อยคำนวณ token ให้
--
--   (แพตเทิร์นเดียวกับ family_group_invites ใน migration 20260824000000)
ALTER TABLE "job_sessions" ENABLE ROW LEVEL SECURITY;


-- ═══════════════════════════════════════════════════════════════════════════
-- 4. สิ่งที่ไฟล์นี้ "ไม่" ทำ (ตั้งใจ)
-- ═══════════════════════════════════════════════════════════════════════════
--   ✗ ไม่ backfill booking เดิม
--     booking ที่มีอยู่ก่อน migration นี้จะไม่มี job_session → สแกน QR ไม่ได้
--     การ์ด PYG-436 เขียนไว้ตรง ๆ ว่า "in-flight booking เดิมไม่มี session
--     (prototype = ข้าม, บันทึกไว้)" → บันทึกไว้ตรงนี้แล้ว
--     ทางแก้ถ้าวันหนึ่งจำเป็น: เขียนเป็น script ฝั่ง app (ไม่ใช่ SQL ล้วน)
--     เพราะต้องคำนวณ token + valid_from/until ด้วยสูตรเดียวกับ JobQrService
--
--   ✗ ไม่มี trigger อัปเดต updated_at
--     ทำตามตารางอื่นในรีโปนี้ทั้งหมด (DEFAULT now() แล้วให้ app เขียนเอง)
--     เพื่อให้ `prisma db pull` ไม่มี diff
--
--   ✗ ไม่สร้างตาราง job_scan_events / enum ใด ๆ — เป็นของ PYG-436
--
--   ✗ ไม่แตะ job_events เดิม — ระบบเช็คอิน/เช็คเอาท์ปัจจุบัน (PYG-352/358)
--     ยังทำงานเหมือนเดิมทุกประการ การบังคับให้ต้องสแกนก่อนเป็นงานของ PYG-435


-- ═══════════════════════════════════════════════════════════════════════════
-- 5. ROLLBACK (รันมือถ้าต้องถอย — Prisma ไม่มี down migration ให้)
-- ═══════════════════════════════════════════════════════════════════════════
--   DROP TABLE IF EXISTS "job_sessions";
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20260828000000_add_job_sessions';
--
--   ปลอดภัยเพราะไฟล์นี้ "เพิ่มของใหม่ล้วน ๆ" ไม่ได้แก้หรือลบอะไรของเดิมเลย
--   ตารางเดียวที่ถูกอ้างถึงคือ bookings ซึ่งถูกอ้างผ่าน FK ทางเดียว (job_sessions → bookings)
