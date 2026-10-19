-- ═══════════════════════════════════════════════════════════════════════════
-- PYG-307 · TASK 4 — CHECK constraint ให้ caregiver_payout_accounts
--
-- ตารางนี้ไม่มี CHECK เลยตั้งแต่ PYG-306 ทั้งที่ทุกคอลัมน์เป็น text อิสระ
-- ค่าที่หลุดชุดจะเงียบจนกว่าจะไปโผล่ตอนยิง Omise (คือตอนจ่ายเงิน) — สายเกินไป
--
-- ★ bank_code: ชุดนี้ต้องตรงกับ src/common/constants/omise-banks.constant.ts เป๊ะ
--   แก้ที่ไหนต้องแก้อีกที่เสมอ (มี test ตรึงว่า tmb/lhbank ห้ามกลับมา)
--   'tmb' และ 'lhbank' ที่เคยอยู่ในโค้ดไม่ได้อยู่ในชุดนี้ — Omise ไม่รับแล้ว
--   (TMB ควบรวมเป็น ttb, lhbank เปลี่ยนรหัสเป็น lhb)
--
-- ★ ทำไมไม่ใส่ CHECK ความยาว account_number_last4 = 4 อย่างเดียวแต่ใส่ regex ด้วย
--   last4 เป็นสิ่งเดียวที่เราเปิดเผยได้ตามกฎ PDPA ของงานนี้ ถ้าวันหนึ่งมีบั๊กเขียน
--   เลขเต็มลงช่องนี้ regex '^[0-9]{4}$' จะปฏิเสธทันทีที่ DB ไม่ต้องรอ code review
--
-- ── DRY RUN บน staging (evsewucpighcbnhofmug) ก่อน apply ────────────────────
--   SELECT count(*) FILTER (...) จาก 2 แถวที่มีอยู่:
--     bad_bank_code = 0   bad_status = 0
--     bad_recipient_status = 0   bad_last4 = 0
--   → ไม่ต้อง normalize ข้อมูลเดิมก่อน constraint ติดได้เลย
--
--   หมายเหตุ: มี 1 แถว (scb/****6789) ที่ status='active' คู่กับ
--   recipient_status='unverified' ซึ่งขัดกันเอง — จงใจ "ไม่" ใส่ CHECK ข้ามคอลัมน์
--   มาดักในไฟล์นี้ เพราะจะทำให้ migration ล้มทันที การซ่อมแถวนั้นเป็นงานของ
--   TASK 5 ซึ่งต้องมี data migration + dry-run ของตัวเอง
--
-- deploy ด้วย `prisma migrate deploy` เท่านั้น (ห้าม migrate dev / db push)
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. bank_code ต้องอยู่ในชุดที่ Omise รองรับจริง (lowercase) ──────────────
ALTER TABLE "caregiver_payout_accounts"
  ADD CONSTRAINT "caregiver_payout_accounts_bank_code_check"
  CHECK ("bank_code" IN (
    'bbl', 'kbank', 'ktb', 'scb', 'bay', 'ttb', 'kk', 'citi', 'cimb',
    'uob', 'gsb', 'baac', 'ghb', 'tisco', 'lhb', 'icbc', 'sc', 'ibank'
  ));

-- ─── 2. status: วงจรชีวิตบัญชีรับเงิน ───────────────────────────────────────
--   pending  = ยังไม่พร้อมรับโอน (เพิ่งกรอก / recipient ยังไม่ผ่าน / ถูกปฏิเสธ)
--   active   = พร้อมรับโอน — ตั้งได้จาก webhook recipient.verified เท่านั้น
--   inactive = ปิดใช้งาน (caregiver ลาออก / admin ระงับ)
ALTER TABLE "caregiver_payout_accounts"
  ADD CONSTRAINT "caregiver_payout_accounts_status_check"
  CHECK ("status" IN ('pending', 'active', 'inactive'));

-- ─── 3. recipient_status: สถานะฝั่ง Omise ───────────────────────────────────
--   unverified = ยังไม่ได้ส่งให้ Omise (หรือส่งแล้วแต่ระบบขัดข้อง ให้ลองใหม่ได้)
--   pending    = สร้าง recipient แล้ว รอ Omise ตรวจ
--   verified   = Omise ยืนยันแล้ว ← เงื่อนไขเดียวที่โอนเงินได้
--   failed     = Omise ปฏิเสธ ต้องให้ caregiver แก้บัญชีใหม่
ALTER TABLE "caregiver_payout_accounts"
  ADD CONSTRAINT "caregiver_payout_accounts_recipient_status_check"
  CHECK ("recipient_status" IN ('unverified', 'pending', 'verified', 'failed'));

-- ─── 4. last4 ต้องเป็นตัวเลข 4 หลักเป๊ะ — ด่านสุดท้ายกันเลขบัญชีเต็มรั่ว ──────
ALTER TABLE "caregiver_payout_accounts"
  ADD CONSTRAINT "caregiver_payout_accounts_last4_check"
  CHECK ("account_number_last4" ~ '^[0-9]{4}$');
