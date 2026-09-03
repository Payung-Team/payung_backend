-- PYG-435 — [BE] Scan validation + gate check-in/out
--
-- การ์ดแม่: PYG-433 (QR check-in/out for caregiver jobs)
-- Epic:     PYG-350 (Proof-of-Work Monitoring — Check-in / Check-out & GPS)
--
-- ⚠ ไฟล์นี้ "เขียนมือ" ตามกติกาของทีม — ห้ามรัน prisma migrate dev / db push
--   คนเดียวที่รัน `prisma migrate deploy` คือ Sam เท่านั้น
--   ไฟล์นี้ต้องรัน "หลัง" 20260828000000_add_job_sessions เสมอ (มี FK ชี้ไปตารางนั้น)
--
-- ─────────────────────────────────────────────────────────────────────────────
-- ★ ขอบเขตของไฟล์นี้ — อ่านก่อน review
--
--   สร้าง "แค่ตาราง job_scan_events" ตัวเดียว = ครึ่งหลังของการ์ด PYG-436
--   (ครึ่งแรกคือ job_sessions ซึ่งออกไปแล้วใน migration 20260828000000)
--   หลังไฟล์นี้ผ่าน → การ์ด PYG-436 ไม่เหลืองาน schema อีกแล้ว เหลือแค่ deploy + rollback test
--
--   เหตุผลที่ต้องมาพร้อม PYG-435: AC ของการ์ดเขียนว่า
--   "เขียน JobScanEvent ทุกครั้ง (สำเร็จ+ล้มเหลว)" — ไม่มีตารางนี้ AC ข้อนั้นทำไม่ได้เลย
-- ─────────────────────────────────────────────────────────────────────────────
--
-- ★★ ตารางนี้คือ "สมุดบันทึก" ไม่ใช่ "แหล่งความจริง" ★★
--   ไม่มีโค้ดไหนในระบบอ่านตารางนี้ไปตัดสินใจอะไรทั้งสิ้น
--   ความจริงเรื่องสถานะงานอยู่ที่ job_sessions.status + job_events + bookings.status
--   ถ้าวันหนึ่งมี query ที่อ่าน job_scan_events ไปตัดสินใจ = ออกแบบผิดแล้ว ให้ทักท้วง
--
-- หมายเหตุชนิดข้อมูล (อย่าเดา — ของจริงในดีบีเป็นแบบนี้):
--   bookings.id     = UUID  → booking_id  เป็น UUID
--   job_sessions.id = UUID  → session_id  เป็น UUID
--   users.id        = TEXT  → scanned_by  เป็น TEXT
--   caregivers.id   = TEXT  → caregiver_id เป็น TEXT


-- ═══════════════════════════════════════════════════════════════════════════
-- 1. TABLE
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "job_scan_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),

    -- ★ NULL ได้ทั้งคู่ โดยตั้งใจ
    --   คนสแกน QR มั่ว ๆ (หรือ QR ของระบบอื่น) ก็ต้องถูกบันทึกเหมือนกัน
    --   ตอนนั้นเรายังไม่รู้ด้วยซ้ำว่ามันเป็นงานใบไหน → สองคอลัมน์นี้จึงเป็น NULL
    "session_id" UUID,
    "booking_id" UUID,

    -- users.id ของคนกดสแกน — รู้เสมอ เพราะต้องล็อกอินก่อนถึงจะยิง mutation ได้
    "scanned_by" TEXT NOT NULL,
    -- caregivers.id ถ้าบัญชีนั้นมีโปรไฟล์ผู้ดูแล
    "caregiver_id" TEXT,

    -- sha256 ของ token ที่สแกนมา (hex 64) — เก็บแม้ token จะผิด
    -- ★ เก็บ hash ไม่ใช่ token ดิบ ด้วยเหตุผลเดียวกับ job_sessions.token_hash
    --   ทำให้ตอบคำถาม "มีคนเอา QR ใบเดิมมาลองซ้ำกี่ครั้ง" ได้ โดยไม่ต้องเก็บของลับไว้
    "token_hash" TEXT NOT NULL,

    -- action ที่ "พยายามจะทำ" — 'CHECK_IN' | 'CHECK_OUT' | 'NONE'
    -- NONE = ยังไม่ทันรู้ว่าจะทำอะไร (หา session ไม่เจอ / งานถูกยกเลิกไปแล้ว)
    "action" TEXT NOT NULL,

    -- รหัสผลลัพธ์ — ค่าทั้งหมดอยู่ที่ SCAN_RESULT ใน src/monitoring/qr/qr.constants.ts
    "result" TEXT NOT NULL,

    -- ข้อความไทยที่ผู้สแกนเห็นบนหน้าจอตอนนั้น
    -- เก็บไว้เพื่อให้แอดมินอ่านย้อนหลังได้ว่า "ระบบบอกผู้ดูแลว่าอะไร" ตอนมีข้อพิพาท
    -- (ข้อความอาจถูกแก้คำในอนาคต ค่าที่เก็บไว้จะยังเป็นของ ณ วันนั้น ซึ่งถูกต้องแล้ว)
    "reason" TEXT,

    -- เวลาของเซิร์ฟเวอร์เท่านั้น — ไม่รับเวลาจากเครื่อง client
    -- ไม่มี created_at เพราะจะเป็นค่าเดียวกันเป๊ะ ๆ ซ้ำซ้อนเปล่า ๆ
    "scanned_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "job_scan_events_pkey" PRIMARY KEY ("id")
);

-- ─── FK ไป job_sessions ────────────────────────────────────────────────────
-- ★ ON DELETE SET NULL ไม่ใช่ CASCADE — ต่างจากตารางอื่นในรีโปนี้โดยตั้งใจ
--   audit log ต้องไม่หายไปพร้อมกับของที่มันบันทึกไว้ ไม่งั้นการลบของทิ้ง
--   จะกลายเป็นวิธีลบร่องรอยไปในตัว ซึ่งขัดกับเหตุผลที่มีตารางนี้ตั้งแต่แรก
DO $$ BEGIN
    ALTER TABLE "job_scan_events"
        ADD CONSTRAINT "job_scan_events_session_id_fkey"
        FOREIGN KEY ("session_id") REFERENCES "job_sessions"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN
    RAISE NOTICE 'PYG-435: FK job_scan_events_session_id_fkey มีอยู่แล้ว — ข้าม';
END $$;

-- ─── FK ไป bookings ────────────────────────────────────────────────────────
DO $$ BEGIN
    ALTER TABLE "job_scan_events"
        ADD CONSTRAINT "job_scan_events_booking_id_fkey"
        FOREIGN KEY ("booking_id") REFERENCES "bookings"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN
    RAISE NOTICE 'PYG-435: FK job_scan_events_booking_id_fkey มีอยู่แล้ว — ข้าม';
END $$;

-- ─── ไม่มี FK บน scanned_by / caregiver_id โดยตั้งใจ ───────────────────────
--   เหตุผลเดียวกับ ON DELETE SET NULL ด้านบน: ถ้าบัญชีถูกลบตามคำขอ PDPA
--   แถว audit ต้องยังอยู่ (ไม่งั้น "ลบบัญชี" = "ลบหลักฐาน")
--   ค่าที่เหลืออยู่เป็นแค่ id ที่ไม่ชี้ไปไหนแล้ว ซึ่งไม่ใช่ข้อมูลส่วนบุคคลในตัวมันเอง

-- ─── CHECK: action ต้องเป็นค่าที่รู้จักเท่านั้น ─────────────────────────────
-- ค่าพวกนี้ต้องตรงกับ SCAN_ACTION ใน src/monitoring/qr/qr.constants.ts เป๊ะ ๆ
DO $$ BEGIN
    ALTER TABLE "job_scan_events"
        ADD CONSTRAINT "job_scan_events_action_check"
        CHECK ("action" IN ('CHECK_IN', 'CHECK_OUT', 'NONE'));
EXCEPTION WHEN duplicate_object THEN
    RAISE NOTICE 'PYG-435: CHECK job_scan_events_action_check มีอยู่แล้ว — ข้าม';
END $$;

-- ─── CHECK: result ต้องเป็นรหัสที่รู้จักเท่านั้น ───────────────────────────
-- ⚠ อ่านก่อนเพิ่มรหัสใหม่:
--   รหัสผลลัพธ์คือ "สัญญา" ระหว่าง BE / FE (PYG-438) / QA (PYG-440)
--   ถ้าปล่อยเป็น TEXT อิสระ วันที่พิมพ์ผิดตัวเดียว FE จะตกไปที่ error กลาง ๆ เงียบ ๆ
--   จึงยอมแลกด้วยความยุ่งยาก: เพิ่มรหัสใหม่ = ต้องออก migration ใหม่ 1 ไฟล์
--   (ฝั่งแอปห่อการเขียน log ด้วย try/catch อยู่แล้ว ถ้า CHECK ไม่ผ่านจะไม่ทำให้ผู้ใช้พัง
--    แต่จะ "เสีย log แถวนั้นไปเงียบ ๆ" ซึ่งแย่กว่า — อย่าลืมแก้ทั้งสองที่พร้อมกัน)
DO $$ BEGIN
    ALTER TABLE "job_scan_events"
        ADD CONSTRAINT "job_scan_events_result_check"
        CHECK ("result" IN (
            'SUCCESS',            -- สแกนผ่าน เช็คอิน/เช็คเอาท์สำเร็จ
            'TOKEN_NOT_FOUND',    -- token ไม่ตรงกับ session ใดเลย
            'NOT_A_CAREGIVER',    -- บัญชีที่สแกนไม่มีโปรไฟล์ผู้ดูแล
            'WRONG_CAREGIVER',    -- เป็นผู้ดูแล แต่ไม่ใช่คนที่รับงานใบนี้
            'BOOKING_INACTIVE',   -- งานถูกยกเลิก / ถูกปฏิเสธ
            'OUT_OF_WINDOW',      -- สแกนนอกช่วง valid_from..valid_until
            'ALREADY_COMPLETED',  -- session เป็น CHECKED_OUT แล้ว (สแกนครั้งที่สาม)
            'TOO_SOON',           -- สแกนถี่เกินกำหนดขั้นต่ำระหว่าง action
            'DUPLICATE',          -- สแกนพร้อมกันสองครั้ง แล้วแถวนี้เป็นฝ่ายแพ้
            'WRONG_SEQUENCE',     -- ลำดับไม่ถูก (เช่น เช็คเอาท์ทั้งที่ยังไม่มีเช็คอิน)
            'JOB_NOT_READY'       -- งานยังไม่พร้อม (ยังไม่ถึงวัน / ยังไม่จ่ายเงิน / สถานะไม่ใช่ confirmed)
        ));
EXCEPTION WHEN duplicate_object THEN
    RAISE NOTICE 'PYG-435: CHECK job_scan_events_result_check มีอยู่แล้ว — ข้าม';
END $$;

-- ─── CHECK: token_hash ต้องเป็น sha256 hex เท่านั้น ────────────────────────
-- ด่านสุดท้ายกันไม่ให้ token ดิบหลุดลงดีบี แม้โค้ดฝั่ง app จะเขียนผิด
DO $$ BEGIN
    ALTER TABLE "job_scan_events"
        ADD CONSTRAINT "job_scan_events_token_hash_check"
        CHECK ("token_hash" ~ '^[0-9a-f]{64}$');
EXCEPTION WHEN duplicate_object THEN
    RAISE NOTICE 'PYG-435: CHECK job_scan_events_token_hash_check มีอยู่แล้ว — ข้าม';
END $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- 2. INDEXES
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 2.1 "งานใบนี้ถูกสแกนมากี่ครั้ง" ───────────────────────────────────────
-- การ์ด PYG-436 ระบุ index bookingId ไว้ตรง ๆ
CREATE INDEX IF NOT EXISTS "job_scan_events_booking_id_idx"
    ON "job_scan_events" ("booking_id");

-- ─── 2.2 ไทม์ไลน์การสแกนของ session หนึ่ง ๆ ────────────────────────────────
-- ใช้ตอนแอดมินสอบสวนข้อพิพาท: "ใบนี้ถูกสแกนกี่ครั้ง เวลาไหน ผลอะไรบ้าง"
CREATE INDEX IF NOT EXISTS "job_scan_events_session_id_scanned_at_idx"
    ON "job_scan_events" ("session_id", "scanned_at");

-- ⚠ ตั้งใจ "ไม่" ทำ index บน scanned_by
--   มันจะมีประโยชน์ตอนทำหน้า "ผู้ใช้คนนี้สแกนพลาดถี่ผิดปกติ" ซึ่งยังไม่มีการ์ดไหนทำ
--   index ที่ไม่มีใครใช้ = ต้นทุนตอนเขียนทุกแถว โดยไม่ได้อะไรกลับมา
--   ถ้าวันหนึ่งทำหน้านั้น ค่อยเพิ่มใน migration ของการ์ดนั้น


-- ═══════════════════════════════════════════════════════════════════════════
-- 3. ROW LEVEL SECURITY
-- ═══════════════════════════════════════════════════════════════════════════
-- ★ เปิด RLS แต่ "ไม่สร้าง policy เลย" — ตั้งใจ 100% (แพตเทิร์นเดียวกับ job_sessions)
--
--   RLS เปิดแล้วไม่มี policy = ปฏิเสธทุกแถวสำหรับทุก role ที่ไม่ใช่เจ้าของตาราง
--   client ที่ถือ anon key ยิงตรงเข้า Supabase อ่านตารางนี้ไม่ได้เลยแม้แต่แถวเดียว
--
--   ทำไมต้องเข้ม: ตารางนี้เก็บ token_hash เหมือน job_sessions
--   ปล่อยให้อ่านได้ = แจกลายนิ้วมือของ QR ออกไปให้เอาไปเทียบแบบ offline
ALTER TABLE "job_scan_events" ENABLE ROW LEVEL SECURITY;


-- ═══════════════════════════════════════════════════════════════════════════
-- 4. สิ่งที่ไฟล์นี้ "ไม่" ทำ (ตั้งใจ)
-- ═══════════════════════════════════════════════════════════════════════════
--   ✗ ไม่สร้าง PG enum type ให้ action / result
--     ใช้ TEXT + CHECK แทน ให้เหมือน job_sessions.status และ job_events.event_type
--     ที่อยู่ข้าง ๆ กัน (การ์ด PYG-436 เขียนคำว่า "enum" ไว้ ซึ่งในโค้ดคือ TS/GraphQL enum
--     ที่ src/monitoring/qr/entities/ — ฝั่งดีบีจงใจไม่ทำ PG enum เพราะ ALTER TYPE
--     ต่อท้ายค่าใหม่ทำใน transaction เดียวกับ migration อื่นไม่ได้ใน PG หลายเวอร์ชัน)
--
--   ✗ ไม่มี retention / TTL ให้แถวเก่า
--     prototype นี้เก็บทุกแถวตลอดไป ปริมาณจริงคือ ~2-5 แถวต่องาน 1 ใบ ซึ่งเล็กมาก
--     ถ้าวันหนึ่งใหญ่ขึ้นจนต้องตัด ให้ทำเป็นการ์ดแยกพร้อมนโยบายเก็บข้อมูลของ PDPA
--
--   ✗ ไม่แตะ job_sessions / job_events / bookings เลย
--     ไฟล์นี้เพิ่มของใหม่ล้วน ๆ ระบบเดิมทำงานเหมือนเดิมทุกประการ


-- ═══════════════════════════════════════════════════════════════════════════
-- 5. ROLLBACK (รันมือถ้าต้องถอย — Prisma ไม่มี down migration ให้)
-- ═══════════════════════════════════════════════════════════════════════════
--   DROP TABLE IF EXISTS "job_scan_events";
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20260829000000_add_job_scan_events';
--
--   ปลอดภัยเพราะไฟล์นี้ "เพิ่มของใหม่ล้วน ๆ" ไม่ได้แก้หรือลบอะไรของเดิมเลย
--   ⚠ ถ้าจะถอย 20260828000000 (job_sessions) ด้วย ต้องถอยไฟล์นี้ "ก่อน" เสมอ
--     เพราะมี FK ชี้ไป job_sessions อยู่
