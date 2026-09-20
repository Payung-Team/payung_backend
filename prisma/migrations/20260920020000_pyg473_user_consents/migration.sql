-- PYG-473 — ตาราง user_consents: ประวัติความยินยอมตาม PDPA (append-only)
--
-- ⚠ เขียนมือ ห้ามรัน prisma migrate dev / db push — Wasan รัน `prisma migrate deploy` เท่านั้น
--
-- ทำไมต้องมี: ต้องตอบย้อนหลังได้ว่า "ผู้ใช้คนนี้ยินยอมนโยบายเวอร์ชันไหน เมื่อไหร่ จากช่องทางไหน"
--   (PDPA ม.19 — ภาระการพิสูจน์อยู่ที่ผู้ควบคุมข้อมูล) · การ์ดแม่ PYG-465
--
-- สิ่งที่ไฟล์นี้ทำ: สร้างตารางใหม่ + index + RLS + trigger กันแก้ย้อนหลัง
--   ไม่แตะตารางเดิมสักตาราง ไม่มี backfill
--
-- ★ append-only บังคับที่ "ฐาน" ไม่ใช่แค่มารยาทของโค้ด:
--   trigger บล็อก UPDATE ทุกกรณี — ถอนความยินยอม = INSERT แถวใหม่ granted = false
--   **ไม่บล็อก DELETE** โดยตั้งใจ: คำขอลบบัญชีตาม PDPA ม.33 ต้องลบ consent ตามไปด้วยผ่าน
--   FK ON DELETE CASCADE — ถ้าบล็อก DELETE ด้วย การลบบัญชีจะล้มทั้งชุด
--
-- ★ consent_type ไม่มี CHECK โดยตั้งใจ — ชุด consent ยังไม่นิ่ง (PYG-472 ข้อความ,
--   PYG-503 ข้อมูลอ่อนไหว ม.26, PYG-505 การเปิดเผยข้อมูล) · คุมค่าด้วยค่าคงที่ฝั่งโค้ดใน PYG-474
--   ถ้าจะล็อกเป็น CHECK ให้ทำหลัง PYG-472 เคาะรายการจบ
--
-- ★ RLS: ตามแพตเทิร์น notifications/care_logs — client อ่านได้เฉพาะของตัวเอง
--   ไม่มี policy INSERT/UPDATE/DELETE → เขียนได้ผ่าน backend (service-role) เท่านั้น
--
-- Dry-run (prod, 2026-09-20 ก่อนรัน):
--   SELECT to_regclass('public.user_consents') → NULL (ยังไม่มีตาราง)
--   users 159 แถว → ไม่มีการ backfill consent ให้ใครทั้งสิ้น (ผู้ใช้เดิมยังไม่เคยให้ความยินยอม
--   ในระบบนี้ — การขอย้อนหลังเป็นงานของ PYG-504)
--
-- idempotent: รันซ้ำได้ (IF NOT EXISTS / DROP POLICY IF EXISTS ก่อน CREATE)
--
-- ROLLBACK (มือ):
--   DROP TRIGGER IF EXISTS user_consents_no_update ON "user_consents";
--   DROP FUNCTION IF EXISTS public.user_consents_block_update();
--   DROP TABLE IF EXISTS "user_consents";
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20260920020000_pyg473_user_consents';
--   ⚠ ข้อมูลความยินยอมที่บันทึกไปแล้วจะหายทั้งหมด — ถ้ามีแถวจริงแล้ว ให้ export เก็บก่อน

-- ─── 1. ตาราง ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "user_consents" (
    "id"             UUID        NOT NULL DEFAULT gen_random_uuid(),
    "user_id"        TEXT        NOT NULL,
    "consent_type"   TEXT        NOT NULL,
    "policy_version" TEXT        NOT NULL,
    "granted"        BOOLEAN     NOT NULL,
    "granted_at"     TIMESTAMPTZ NOT NULL DEFAULT now(),
    "source"         TEXT,
    "ip_address"     INET,
    "user_agent"     TEXT,
    "created_at"     TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "user_consents_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "user_consents_user_id_fkey" FOREIGN KEY ("user_id")
        REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- ─── 2. Index ──────────────────────────────────────────────────────────────────
-- ตามการ์ด: (user_id, consent_type)
CREATE INDEX IF NOT EXISTS "idx_user_consents_user_type"
    ON "user_consents" ("user_id", "consent_type");

-- คำถามที่ระบบถามบ่อยที่สุดคือ "ล่าสุดของ consent นี้คืออะไร" → ต้องได้จาก index ตรง ๆ
CREATE INDEX IF NOT EXISTS "idx_user_consents_latest"
    ON "user_consents" ("user_id", "consent_type", "granted_at" DESC);

-- ─── 3. append-only: บล็อก UPDATE ที่ระดับฐาน ──────────────────────────────────
-- trigger ทำงานกับทุก role รวม service-role (ต่างจาก RLS ที่ service-role bypass)
CREATE OR REPLACE FUNCTION public.user_consents_block_update()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'user_consents เป็น append-only: ถอนความยินยอมให้ INSERT แถวใหม่ granted = false';
END;
$$;

DROP TRIGGER IF EXISTS user_consents_no_update ON "user_consents";
CREATE TRIGGER user_consents_no_update
    BEFORE UPDATE ON "user_consents"
    FOR EACH ROW EXECUTE FUNCTION public.user_consents_block_update();

-- ─── 4. RLS ────────────────────────────────────────────────────────────────────
ALTER TABLE "user_consents" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "user_consents_select_own" ON "user_consents";
CREATE POLICY "user_consents_select_own" ON "user_consents"
    FOR SELECT
    TO authenticated
    USING (
        user_id IN (SELECT id FROM users WHERE supabase_uid = auth.uid()::text)
    );

-- ★ ไม่มี policy INSERT/UPDATE/DELETE ให้ client — บันทึกความยินยอมผ่าน backend เท่านั้น
--   (ถ้า client insert เองได้ หลักฐานความยินยอมก็ถูกปลอมได้)

-- ─── 5. post-assertion ─────────────────────────────────────────────────────────
DO $$
DECLARE
    has_rls     BOOLEAN;
    policy_cnt  INTEGER;
    trigger_cnt INTEGER;
BEGIN
    SELECT relrowsecurity INTO has_rls FROM pg_class
     WHERE oid = 'public.user_consents'::regclass;
    SELECT count(*) INTO policy_cnt FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'user_consents';
    SELECT count(*) INTO trigger_cnt FROM pg_trigger
     WHERE tgrelid = 'public.user_consents'::regclass AND NOT tgisinternal;

    IF has_rls IS NOT TRUE OR policy_cnt <> 1 OR trigger_cnt <> 1 THEN
        RAISE EXCEPTION 'PYG-473: ตั้งค่าไม่ครบ (rls=%, policies=%, triggers=%)',
            has_rls, policy_cnt, trigger_cnt;
    END IF;
END $$;
