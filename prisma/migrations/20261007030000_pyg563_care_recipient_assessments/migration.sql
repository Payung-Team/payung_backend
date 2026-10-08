-- PYG-608 — [DB] สร้างตาราง care_recipient_assessments เก็บคำตอบ ADL คะแนน และ Flags
--
-- การ์ดแม่: PYG-563 (S08 · ญาติทำแบบประเมิน ADL และเลือก Flags ของผู้สูงอายุต่อจาก onboarding)
--
-- ⚠ เขียนมือ ห้ามรัน prisma migrate dev / db push — Sammy gate และรัน `prisma migrate deploy` เท่านั้น
--   หลัง deploy ให้เช็คว่า `prisma db pull` ไม่มี diff (schema.prisma sync ด้วยมือแล้ว)
--
-- สิ่งที่ไฟล์นี้ทำ: สร้างตารางใหม่ 1 ตาราง + เปิด RLS — ไม่แตะตารางเดิม ไม่มี backfill
--   ผู้สูงอายุเดิมไม่มีแถวในตารางนี้จนกว่าญาติจะทำแบบประเมิน (S08-AC10)
--   "มีแถว = มีแบบประเมิน" (S08-AC9)
--
-- ─────────────────────────────────────────────────────────────────────────────
-- ★ ต่างจาก SQL ที่การ์ดเสนอ 1 จุด — ตรวจจาก DB จริงแล้ว (2026-10-07)
--
--   care_recipients.id = UUID  → care_recipient_id เป็น UUID ตามการ์ด
--   users.id           = TEXT  → assessed_by เป็น TEXT ไม่ใช่ UUID (uuid จะสร้าง FK ไม่ได้)
-- ─────────────────────────────────────────────────────────────────────────────
--
-- มติ 4 ข้อ (7 ต.ค. 2026 — ตามที่การ์ดเสนอทุกข้อ):
--   1) RLS: เปิด ไม่มี policy — ข้อมูลสุขภาพ (S08-R12) client (anon / authenticated ผ่าน PostgREST)
--      อ่านเขียนตรงไม่ได้ backend ต่อด้วย role postgres (bypassrls) จึงใช้ได้ปกติ
--   2) ลบผู้สูงอายุ → ผลประเมินถูกลบตาม (ON DELETE CASCADE)
--      ★ ข้อควรรู้: care_recipients ใช้ "soft delete" (is_deleted / deleted_at — PYG-460 ห้ามลบจริง)
--        CASCADE จึงทำงานเฉพาะตอนแถวถูกลบจริง (เช่น ลบบัญชี users → care_recipients → ตารางนี้)
--        การกดลบโปรไฟล์ตามปกติ "ไม่" ลบผลประเมิน — ถ้าต้องการให้หายด้วย เป็นหน้าที่ BE (PYG-609)
--   3) เก็บเฉพาะครั้งล่าสุด: UNIQUE (care_recipient_id) — 1 แถวต่อผู้สูงอายุ 1 คน ไม่เก็บประวัติ
--   4) ไม่เก็บคำตอบค้าง: ไม่มีคอลัมน์สถานะ และ adl_total_score เป็น NOT NULL
--
-- ข้อตัดสินใจอื่น:
--   • assessed_by → users เป็น ON DELETE RESTRICT (การ์ดไม่ได้ระบุ = NO ACTION ซึ่งผลเท่ากัน)
--     คอลัมน์เป็น NOT NULL จึง SET NULL ไม่ได้ · ในทางปฏิบัติผู้ประเมินคือญาติเจ้าของโปรไฟล์
--     ซึ่งถ้าถูกลบจริง care_recipients ของเขาจะ CASCADE มาลบแถวนี้ก่อนอยู่แล้ว
--   • adl_answers เป็น JSONB (รหัสข้อ → ค่าคำตอบ) — รายการข้อ ADL ยังรออาจารย์ยืนยัน (S08-R4)
--   • flags ยังไม่มี CHECK ของค่า — รายการ Flags ยังรอยืนยัน ตรวจที่ service ไปก่อน
--   • CHECK คะแนน 0–20 อิงรายการ ADL ที่ยังรอยืนยัน — ถ้าช่วงคะแนนเปลี่ยน ต้องมี migration แก้ constraint
--   • updated_at ไม่มี trigger — BE ต้องตั้งค่าเองทุกครั้งที่บันทึก (เหมือน care_recipients.updated_at)
--   • S09 (PYG-613) จะเพิ่มคอลัมน์กลุ่มในตารางนี้ → ต้อง deploy ไฟล์นี้ก่อน
--
-- idempotent: CREATE TABLE IF NOT EXISTS
--
-- ROLLBACK (มือ):
--   DROP TABLE IF EXISTS "care_recipient_assessments";
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261007030000_pyg563_care_recipient_assessments';
--   ⚠ ถ้า PYG-609 ขึ้นแล้วและญาติทำแบบประเมินไปแล้ว rollback = ผลประเมินหายทั้งหมด


CREATE TABLE IF NOT EXISTS "care_recipient_assessments" (
    "id"                    UUID NOT NULL DEFAULT gen_random_uuid(),
    "care_recipient_id"     UUID NOT NULL,
    -- คำตอบ ADL รายข้อ: รหัสข้อ → ค่าคำตอบ (รวม "ไม่แน่ใจ")
    "adl_answers"           JSONB NOT NULL,
    -- backend เป็นผู้รวมคะแนน ไม่รับจาก client (S08-R3)
    "adl_total_score"       INTEGER NOT NULL,
    -- จำนวนข้อที่ตอบ "ไม่แน่ใจ"
    "unsure_count"          INTEGER NOT NULL DEFAULT 0,
    -- เฉพาะ Flags ที่ญาติเลือกเอง
    "flags"                 TEXT[] NOT NULL DEFAULT '{}',
    "no_special_conditions" BOOLEAN NOT NULL DEFAULT false,
    -- Flag "ไม่แน่ใจ" ที่ระบบตั้งเมื่อ unsure_count >= 3 — แยกจาก flags
    -- เพื่อให้อยู่ร่วมกับ no_special_conditions ได้ (S08-E2)
    "has_unsure_flag"       BOOLEAN NOT NULL DEFAULT false,
    -- มีความหมายเฉพาะเมื่อ flags มี 'dementia' · NULL = ไม่ได้เลือกสมองเสื่อม / ไม่ได้ระบุ
    "dementia_severe"       BOOLEAN,
    "assessed_by"           TEXT NOT NULL,
    -- วันที่ประเมินล่าสุด (S08-AC8)
    "assessed_at"           TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "created_at"            TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at"            TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "care_recipient_assessments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "care_recipient_assessments_recipient_key" UNIQUE ("care_recipient_id"),
    CONSTRAINT "care_recipient_assessments_care_recipient_id_fkey"
        FOREIGN KEY ("care_recipient_id") REFERENCES "care_recipients"("id")
        ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "care_recipient_assessments_assessed_by_fkey"
        FOREIGN KEY ("assessed_by") REFERENCES "users"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "care_recipient_assessments_score_check"
        CHECK ("adl_total_score" BETWEEN 0 AND 20),
    CONSTRAINT "care_recipient_assessments_unsure_check"
        CHECK ("unsure_count" >= 0),
    -- "ไม่มีเงื่อนไขพิเศษ" อยู่ร่วมกับ Flags ที่ญาติเลือกไม่ได้ (S08-AC4)
    CONSTRAINT "care_recipient_assessments_none_check"
        CHECK (NOT ("no_special_conditions" AND cardinality("flags") > 0))
);

ALTER TABLE "care_recipient_assessments" ENABLE ROW LEVEL SECURITY;

-- post-assertion: ผิดข้อใด migration ล้มทั้งไฟล์
DO $$
DECLARE
    has_rls    BOOLEAN;
    policy_cnt INTEGER;
    con_cnt    TEXT;
BEGIN
    SELECT relrowsecurity INTO has_rls FROM pg_class
     WHERE oid = 'public.care_recipient_assessments'::regclass;
    SELECT count(*) INTO policy_cnt FROM pg_policy
     WHERE polrelid = 'public.care_recipient_assessments'::regclass;
    -- คาด: p=1 (pkey) f=2 (fkey) u=1 (unique) c=3 (check)
    SELECT string_agg(contype || '=' || n, ' ' ORDER BY contype) INTO con_cnt
      FROM (SELECT contype::text, count(*) AS n FROM pg_constraint
             WHERE conrelid = 'public.care_recipient_assessments'::regclass GROUP BY contype) t;

    IF has_rls IS NOT TRUE OR policy_cnt <> 0 OR con_cnt <> 'c=3 f=2 p=1 u=1' THEN
        RAISE EXCEPTION 'PYG-608: ตั้งค่าไม่ครบ (rls=%, policies=%, constraints=%)',
            has_rls, policy_cnt, con_cnt;
    END IF;
END $$;
