-- ═══════════════════════════════════════════════════════════════════════════
-- PYG-416 · SCR-FG2-001 — Join link ระดับกลุ่ม (multi-use) แทนคำเชิญรายอีเมล
--
-- ★ ทำไมเป็น migration ใหม่ ไม่แก้ไฟล์ 20260824000000 เดิม
--   ไฟล์นั้น deploy ลงดีบีจริงไปแล้ว (30 ส.ค. 2569) การแก้ไฟล์ที่ apply แล้ว
--   จะทำให้ checksum ของ Prisma ไม่ตรง แล้ว `migrate deploy` จะปฏิเสธทั้งชุด
--
-- ★ ตาราง family_group_invites เดิม "ไม่ถูกแตะ" ในไฟล์นี้
--   ยังไม่ลบทิ้งเพราะ PYG-417 (acceptInvite) บน branch dev ยังอ้างถึงอยู่
--   การถอนออกจะเป็น migration แยกหลังจาก dev merge เรียบร้อยแล้ว (ดู SCR ข้อ 4)
--
-- ลำดับตามกติกา PYG-411: tables → indexes → FK → RLS
-- deploy ด้วย `prisma migrate deploy` เท่านั้น (ห้าม migrate dev / db push)
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. family_group_join_links ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "family_group_join_links" (
    "id"          UUID NOT NULL DEFAULT gen_random_uuid(),
    "group_id"    UUID NOT NULL,

    -- sha256(token) hex 64 ตัว — ใช้ "ค้นหา" แถวตอนมีคนกดลิงก์เข้ามา
    "token_hash"  TEXT NOT NULL,

    -- ★ token ดิบ — ตั้งใจเก็บ (SCR-FG2-001 ข้อตัดสินใจ ก.)
    --   ต่างจากตาราง invites เดิมที่ห้ามเก็บเด็ดขาด เพราะโมเดลเปลี่ยนไปแล้ว:
    --   ของเดิมคือ "คำเชิญรายบุคคล" = credential ของคนคนหนึ่ง → เก็บดิบไม่ได้
    --   ของใหม่คือ "รหัสกลุ่มที่ตั้งใจให้กระจาย" แบบ invite code ของ Discord/LINE
    --   เจ้าของกลุ่มต้องกด Copy ซ้ำได้เรื่อย ๆ ไม่งั้นเสียจุดประสงค์ของฟีเจอร์
    --   การป้องกันย้ายไปอยู่ที่: RLS ปิดตาย + resolver คืนค่านี้ให้เฉพาะ OWNER
    --   + โควตา max_uses + วันหมดอายุ + เจ้าของกด rotate ได้ทันทีเมื่อลิงก์หลุด
    "token_raw"   TEXT,

    "status"      TEXT NOT NULL DEFAULT 'ACTIVE',

    -- NULL = ไม่จำกัดจำนวนครั้ง (ค่า default จริงมาจาก env FAMILY_JOIN_LINK_MAX_USES)
    "max_uses"    INTEGER,
    "used_count"  INTEGER NOT NULL DEFAULT 0,

    -- now() + FAMILY_JOIN_LINK_TTL_HOURS — คำนวณฝั่ง app เพราะ TTL เป็น config (PYG-428)
    "expires_at"  TIMESTAMPTZ(6) NOT NULL,

    "created_by"  TEXT,
    "revoked_at"  TIMESTAMPTZ(6),
    "created_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "family_group_join_links_pkey" PRIMARY KEY ("id"),

    CONSTRAINT "family_group_join_links_status_check"
        CHECK ("status" IN ('ACTIVE', 'REVOKED')),

    -- กันเผลอเก็บ token ดิบลงช่อง hash (hex ของ sha256 ยาว 64 เสมอ)
    CONSTRAINT "family_group_join_links_token_hash_check"
        CHECK (char_length("token_hash") = 64),

    -- max_uses = 0 ไม่มีความหมาย (ลิงก์ที่ใช้ไม่ได้เลยตั้งแต่เกิด) → บังคับ > 0
    CONSTRAINT "family_group_join_links_max_uses_check"
        CHECK ("max_uses" IS NULL OR "max_uses" > 0),

    -- ★ เพดานอยู่ที่ดีบี ไม่ใช่แค่ที่ service
    --   ถ้าวันหนึ่งมีโค้ดเส้นทางอื่นเผลอ +1 โดยไม่เช็ค โควตาจะยังทะลุไม่ได้อยู่ดี
    CONSTRAINT "family_group_join_links_used_count_check"
        CHECK ("used_count" >= 0 AND ("max_uses" IS NULL OR "used_count" <= "max_uses"))
);

-- ─── 2. ALTER family_group_members ─────────────────────────────────────────
-- ร่องรอยว่าสมาชิกคนนี้เข้ามาด้วยลิงก์ใบไหน
-- โมเดลเดิม (คำเชิญรายอีเมล) มีความสัมพันธ์ 1:1 ระหว่างคำเชิญกับสมาชิก
-- พอเป็นลิงก์ใช้ซ้ำได้ ความสัมพันธ์นั้นหายไป → ต้องเก็บไว้ตรงนี้แทน
-- ไม่งั้นเจ้าของกลุ่มจะตอบไม่ได้ว่า "คนกลุ่มนี้เข้ามาจากลิงก์ที่หลุดใบนั้นหรือเปล่า"
ALTER TABLE "family_group_members"
    ADD COLUMN IF NOT EXISTS "joined_via_link_id" UUID;

-- ─── 3. Indexes ────────────────────────────────────────────────────────────
-- ค้นหาตอนมีคนกดลิงก์ — ต้องเร็วและต้องไม่ซ้ำ
CREATE UNIQUE INDEX IF NOT EXISTS "family_group_join_links_token_hash_key"
    ON "family_group_join_links" ("token_hash");

-- ★ 1 กลุ่ม = 1 ลิงก์ที่ยังใช้ได้ (แทน index เดิมที่บังคับ 1 คำเชิญต่อ group+email)
--   บังคับที่ดีบีเพราะถ้าปล่อยให้ service เช็คเอง สอง request ที่กด "สร้างลิงก์"
--   พร้อมกันจะได้ลิงก์ ACTIVE สองใบ แล้ว rotate จะฆ่าได้ทีละใบ = ลิงก์ผีค้างระบบ
CREATE UNIQUE INDEX IF NOT EXISTS "family_group_join_links_one_active_key"
    ON "family_group_join_links" ("group_id")
    WHERE "status" = 'ACTIVE';

CREATE INDEX IF NOT EXISTS "family_group_join_links_group_id_status_idx"
    ON "family_group_join_links" ("group_id", "status");

CREATE INDEX IF NOT EXISTS "family_group_members_joined_via_link_id_idx"
    ON "family_group_members" ("joined_via_link_id");

-- ─── 4. Foreign keys ───────────────────────────────────────────────────────
-- ลบกลุ่ม → ลิงก์ของกลุ่มหายตามทันที (ลิงก์ที่ชี้ไปกลุ่มที่ไม่มีแล้วคือขยะ)
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'family_group_join_links_group_id_fkey') THEN
  ALTER TABLE "family_group_join_links" ADD CONSTRAINT "family_group_join_links_group_id_fkey"
    FOREIGN KEY ("group_id") REFERENCES "family_groups" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
END IF; END $$;

-- ลบผู้ใช้ที่สร้างลิงก์ → ลิงก์ยังอยู่ (สมาชิกที่เข้ามาแล้วต้องไม่ได้รับผลกระทบ)
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'family_group_join_links_created_by_fkey') THEN
  ALTER TABLE "family_group_join_links" ADD CONSTRAINT "family_group_join_links_created_by_fkey"
    FOREIGN KEY ("created_by") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
END IF; END $$;

-- ลบลิงก์ทิ้ง → สมาชิกยังอยู่ในกลุ่ม แค่ไม่รู้ที่มาแล้ว
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'family_group_members_joined_via_link_id_fkey') THEN
  ALTER TABLE "family_group_members" ADD CONSTRAINT "family_group_members_joined_via_link_id_fkey"
    FOREIGN KEY ("joined_via_link_id") REFERENCES "family_group_join_links" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
END IF; END $$;

-- ─── 5. ขยาย CHECK ของฟีดกิจกรรม ──────────────────────────────────────────
-- ★ ค่าเดิม MEMBER_INVITED / INVITE_REVOKED "ไม่ถอดออก" ทั้งที่ SCR เลิกใช้แล้ว
--   เพราะ branch dev ยังมีโค้ดที่เขียนค่าพวกนี้อยู่ ถ้าถอดตอนนี้ dev จะพังทันที
--   ที่ deploy ตัวถอดจริงคือ migration หลังจาก dev merge เสร็จ (SCR ข้อ 4)
ALTER TABLE "family_group_activity"
    DROP CONSTRAINT IF EXISTS "family_group_activity_action_check";
ALTER TABLE "family_group_activity"
    ADD CONSTRAINT "family_group_activity_action_check" CHECK ("action" IN (
        'GROUP_CREATED',
        'GROUP_RENAMED',
        'MEMBER_INVITED',          -- deprecated (SCR-FG2-001)
        'INVITE_REVOKED',          -- deprecated (SCR-FG2-001)
        'JOIN_LINK_CREATED',       -- PYG-416
        'JOIN_LINK_ROTATED',       -- PYG-416
        'JOIN_LINK_REVOKED',       -- PYG-416
        'MEMBER_JOINED',
        'MEMBER_REJOINED',         -- PYG-417 · SCR ข้อตัดสินใจ ค.
        'MEMBER_LEFT',
        'MEMBER_REMOVED',
        'OWNERSHIP_TRANSFERRED',
        'RECIPIENT_ADDED',
        'RECIPIENT_UPDATED',
        'RECIPIENT_REMOVED',
        'BOOKING_ON_BEHALF'
    ));

ALTER TABLE "family_group_activity"
    DROP CONSTRAINT IF EXISTS "family_group_activity_target_type_check";
ALTER TABLE "family_group_activity"
    ADD CONSTRAINT "family_group_activity_target_type_check"
        CHECK ("target_type" IS NULL OR "target_type" IN
              ('GROUP', 'MEMBER', 'INVITE', 'JOIN_LINK', 'RECIPIENT', 'BOOKING'));

-- ─── 6. RLS — เปิด แต่ "ไม่สร้าง policy เลย" ───────────────────────────────
-- เหตุผลเดียวกับ family_group_invites ในไฟล์ PYG-411 และหนักกว่าเดิม:
-- ตารางนี้เก็บ token_raw ถ้าให้ client แตะได้แม้แต่เจ้าของกลุ่ม
-- ก็เท่ากับแจกลิงก์เข้ากลุ่มของ "ทุกกลุ่ม" ออกไปให้คนที่หา policy รั่วเจอ
-- การอ่านทั้งหมดต้องผ่าน resolver ของ PYG-416 ที่เช็ค OWNER ก่อนเสมอ
ALTER TABLE "family_group_join_links" ENABLE ROW LEVEL SECURITY;
