-- PYG-411 — [BE] Family group schema + migration
--
-- การ์ดแม่: PYG-407 (FG-1 · Create & manage family group)
-- Epic:     PYG-381 (Family Group Management & Booking-on-Behalf)
--
-- ⚠ ไฟล์นี้ "เขียนมือ" ตามกติกาของทีม — ห้ามรัน prisma migrate dev / db push
--   คนเดียวที่รัน `prisma migrate deploy` คือ Sam เท่านั้น
--   หลัง deploy ให้เช็คว่า `prisma db pull` ไม่มี diff (schema.prisma sync ด้วยมือแล้ว)
--
-- ลำดับตามการ์ด: tables → indexes → is_group_member() → enable RLS → policies
--
-- ─────────────────────────────────────────────────────────────────────────────
-- ★ สองเรื่องที่ "ต่างจากที่การ์ดเขียนไว้" — อ่านก่อน review
--
--   1) การ์ดบอกให้ "สร้าง" ตาราง care_recipients แต่ตารางนี้ "มีอยู่แล้ว"
--      (สร้างตั้งแต่ migration 20260530000000_recover_ghost_tables)
--      รวมถึง bookings.care_recipient_id ก็มีอยู่แล้วเช่นกัน
--      → ไฟล์นี้จึงเป็น ALTER ... ADD COLUMN family_group_id แทนการ CREATE
--
--   2) FK ของ care_recipients.family_group_id ใช้ ON DELETE SET NULL ไม่ใช่ CASCADE
--      AC ข้อ A2 เขียนว่า "delete cascades ... recipients" แต่ edge case ของการ์ดเดียวกัน
--      เขียนว่า "delete group with active bookings-on-behalf → bookings keep history"
--      สองข้อนี้ขัดกันเอง เพราะ:
--        - care_recipients เป็นของ "ผู้รับบริการ" (patient_id) มาก่อนที่จะมี family group
--          รวมถึงโปรไฟล์ is_self ที่คนสร้างไว้ใช้เอง
--        - ถ้า CASCADE → ลบกลุ่มทิ้ง = ลบโปรไฟล์คนไข้ทิ้งไปด้วย
--        - แล้ว bookings.care_recipient_id (FK ON DELETE SET NULL) จะโดน null ตาม
--          → ประวัติการจองหาย "ว่าจองให้ใคร" ซึ่งขัด edge case ตรง ๆ
--      → เลือก SET NULL: โปรไฟล์อยู่ต่อ แค่หลุดจากกลุ่มที่ถูกลบ ประวัติการจองครบ
--      (ถ้าทีมอยากได้ CASCADE จริง ๆ แก้บรรทัดเดียวตรง FK ด้านล่าง)
-- ─────────────────────────────────────────────────────────────────────────────
--
-- หมายเหตุชนิดข้อมูล (อย่าเดา — ของจริงในดีบีเป็นแบบนี้):
--   users.id            = TEXT   (Prisma: String @default(uuid()) ไม่มี @db.Uuid)
--   bookings.id         = UUID
--   care_recipients.id  = UUID
--   → FK ที่ชี้ไป users ต้องเป็น TEXT ส่วนที่ชี้ไป group/booking เป็น UUID


-- ═══════════════════════════════════════════════════════════════════════════
-- 1. TABLES
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1.1 family_groups ─────────────────────────────────────────────────────
-- ตัวกลุ่มเอง หนึ่งแถว = หนึ่งครอบครัว
--
-- ★ ไม่มีคอลัมน์ owner_id โดยตั้งใจ
--   "เจ้าของกลุ่ม" อยู่ที่ family_group_members.role = 'OWNER' ที่เดียว
--   ถ้าเก็บซ้ำไว้ที่นี่ด้วย เวลา transferOwnership แล้วอัปเดตไม่ครบทั้งสองที่
--   จะได้กลุ่มที่ "เจ้าของสองคน" หรือ "ไม่มีเจ้าของ" แบบเงียบ ๆ
--   → บังคับ "OWNER ที่ ACTIVE ได้กลุ่มละ 1 คน" ด้วย partial unique index แทน (ข้อ 2.2)
CREATE TABLE IF NOT EXISTS "family_groups" (
    "id"         UUID NOT NULL DEFAULT gen_random_uuid(),

    -- ชื่อกลุ่ม: AC บอก "rename empty or >80 chars → validation"
    -- เช็คที่ดีบีด้วย เผื่อ resolver ลืม trim (defence-in-depth เหมือน RLS)
    "name"       TEXT NOT NULL,

    -- คนสร้างกลุ่ม — เก็บไว้เป็นประวัติ ไม่ใช่ "เจ้าของปัจจุบัน"
    -- (เจ้าของโอนให้คนอื่นได้ แต่คนสร้างเปลี่ยนไม่ได้)
    -- SET NULL: ลบ user ทิ้งแล้วกลุ่มยังอยู่ ไม่ใช่หายตามไปด้วย
    "created_by" TEXT,

    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "family_groups_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "family_groups_name_check"
        CHECK (char_length(btrim("name")) BETWEEN 1 AND 80)
);

-- ─── 1.2 family_group_members ──────────────────────────────────────────────
-- ใครอยู่กลุ่มไหน บทบาทอะไร สถานะอะไร
CREATE TABLE IF NOT EXISTS "family_group_members" (
    "id"         UUID NOT NULL DEFAULT gen_random_uuid(),
    "group_id"   UUID NOT NULL,
    "user_id"    TEXT NOT NULL,

    -- text + CHECK ไม่ใช่ PG enum (กติกาในการ์ด) — เพิ่มค่าใหม่ทีหลังไม่ต้อง ALTER TYPE
    "role"       TEXT NOT NULL DEFAULT 'MEMBER',

    -- ★ ไม่ลบแถวทิ้งตอนโดนเตะ/ออกเอง — เปลี่ยนเป็น REMOVED / LEFT แทน
    --   เพราะ activity feed (FG-3) ต้องอ้างอิงย้อนหลังได้ว่า "ใครเคยอยู่"
    --   และ PYG-412 สั่งไว้ว่า "all checks against status='ACTIVE'"
    "status"     TEXT NOT NULL DEFAULT 'ACTIVE',

    -- คนที่เชิญเข้ามา (NULL = คนสร้างกลุ่มเอง ไม่มีใครเชิญ)
    "invited_by" TEXT,

    "joined_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    -- เวลาที่ออก/โดนเตะ — คู่กับ status ที่ไม่ใช่ ACTIVE
    "removed_at" TIMESTAMPTZ(6),

    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "family_group_members_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "family_group_members_role_check"
        CHECK ("role"   IN ('OWNER', 'MEMBER')),
    CONSTRAINT "family_group_members_status_check"
        CHECK ("status" IN ('ACTIVE', 'REMOVED', 'LEFT'))
);

-- ─── 1.3 family_group_invites ──────────────────────────────────────────────
-- คำเชิญทางอีเมล (FG-2 / PYG-416, PYG-417)
--
-- ★ ห้ามเก็บ token ดิบเด็ดขาด — เก็บแค่ sha256(token) เป็น hex 64 ตัว
--   token ดิบโชว์ครั้งเดียวตอนสร้างลิงก์ แล้วลืมไปเลย
--   ถ้าดีบีหลุด คนได้ไฟล์ไปก็เอา hash ไปกดรับคำเชิญไม่ได้
CREATE TABLE IF NOT EXISTS "family_group_invites" (
    "id"          UUID NOT NULL DEFAULT gen_random_uuid(),
    "group_id"    UUID NOT NULL,

    -- อีเมลผู้ถูกเชิญ — เทียบแบบ case-insensitive ผ่าน index บน lower(email) (ข้อ 2.3)
    "email"       TEXT NOT NULL,

    -- sha256 hex = 64 ตัวอักษรเสมอ ถ้าไม่ใช่แปลว่าเผลอเก็บ token ดิบ → CHECK กันไว้
    "token_hash"  TEXT NOT NULL,

    "status"      TEXT NOT NULL DEFAULT 'PENDING',

    "invited_by"  TEXT,
    "accepted_by" TEXT,

    -- now() + FAMILY_INVITE_TTL_HOURS (168 ชม. = 7 วัน) — คำนวณจากฝั่ง app ไม่ใช่ DEFAULT
    -- เพราะ TTL เป็น config (PYG-428) ไม่ควร hardcode ลง schema
    "expires_at"  TIMESTAMPTZ(6) NOT NULL,

    "accepted_at" TIMESTAMPTZ(6),
    "revoked_at"  TIMESTAMPTZ(6),

    "created_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "family_group_invites_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "family_group_invites_status_check"
        CHECK ("status" IN ('PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED')),
    CONSTRAINT "family_group_invites_token_hash_check"
        CHECK (char_length("token_hash") = 64)
);

-- ─── 1.4 family_group_activity ─────────────────────────────────────────────
-- ฟีดกิจกรรมของกลุ่ม แบบ append-only (FG-3 / PYG-421)
-- ทุกแถวเขียนใน transaction เดียวกับการเปลี่ยนแปลงจริง ห้าม fire-and-forget
CREATE TABLE IF NOT EXISTS "family_group_activity" (
    "id"          UUID NOT NULL DEFAULT gen_random_uuid(),
    "group_id"    UUID NOT NULL,

    -- คนที่ทำ — SET NULL เพราะฟีดต้องอยู่ต่อแม้ user ถูกลบ (โชว์เป็น "ผู้ใช้ที่ถูกลบ")
    "actor_id"    TEXT,

    "action"      TEXT NOT NULL,

    -- ชี้ไปที่อะไร — polymorphic จึง "ไม่มี FK" โดยตั้งใจ
    -- target_id เป็น TEXT เพราะเป้าหมายปนกันทั้ง UUID (booking) และ TEXT (user)
    "target_type" TEXT,
    "target_id"   TEXT,

    -- รายละเอียดเพิ่มเติมที่ไม่คุ้มจะทำเป็นคอลัมน์ เช่น {"oldName":"บ้านยาย","newName":"บ้านย่า"}
    "metadata"    JSONB NOT NULL DEFAULT '{}'::jsonb,

    "created_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "family_group_activity_pkey" PRIMARY KEY ("id"),

    -- ★ CHECK นี้แลกมาด้วยข้อเสีย: เพิ่ม action ใหม่ทีหลังต้องเขียน migration แก้ CHECK
    --   แต่การ์ดสั่ง "text + CHECK instead of enums" จึงทำตาม
    --   (ข้อดีคือพิมพ์ action ผิดแล้ว insert ไม่ผ่านทันที ไม่ใช่ไปเจอตอนหน้าฟีดว่าง)
    CONSTRAINT "family_group_activity_action_check" CHECK ("action" IN (
        'GROUP_CREATED',
        'GROUP_RENAMED',
        'MEMBER_INVITED',
        'INVITE_REVOKED',
        'MEMBER_JOINED',
        'MEMBER_LEFT',
        'MEMBER_REMOVED',
        'OWNERSHIP_TRANSFERRED',
        'RECIPIENT_ADDED',
        'RECIPIENT_UPDATED',
        'RECIPIENT_REMOVED',
        'BOOKING_ON_BEHALF'
    )),
    CONSTRAINT "family_group_activity_target_type_check"
        CHECK ("target_type" IS NULL OR "target_type" IN
              ('GROUP', 'MEMBER', 'INVITE', 'RECIPIENT', 'BOOKING'))
);

-- ─── 1.5 ALTER care_recipients ─────────────────────────────────────────────
-- ตารางนี้ "มีอยู่แล้ว" (ดูหมายเหตุข้อ 1 บนหัวไฟล์) — เติมแค่ลิงก์ไปกลุ่ม
-- NULL = โปรไฟล์ส่วนตัวของ patient คนนั้น ไม่ได้แชร์เข้ากลุ่มไหน (พฤติกรรมเดิมทั้งหมด)
ALTER TABLE "care_recipients" ADD COLUMN IF NOT EXISTS "family_group_id" UUID;

-- ─── 1.6 ALTER bookings ────────────────────────────────────────────────────
-- family_group_id: จองในนามกลุ่มไหน (NULL = จองปกติ ไม่เกี่ยวกับกลุ่ม)
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "family_group_id" UUID;

-- care_recipient_id: ★ มีอยู่แล้วตั้งแต่ 20260530000000 — บรรทัดนี้เป็น no-op
--   เขียนไว้เพื่อให้ตรงกับที่การ์ดสั่ง และกันเคสดีบีที่ยังไม่มีคอลัมน์นี้
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "care_recipient_id" UUID;

-- ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄
-- ★ สองคอลัมน์ถัดไป "เกินจากที่การ์ด PYG-411 เขียนไว้" — ตั้งใจใส่ ขอให้ review ตรงนี้
--
--   PYG-424 (createBookingOnBehalf) สั่งว่า:
--     "INSERT booking with family_group_id, care_recipient_id, memberDetails, booked_by=caller"
--   แต่ PYG-424 เป็นการ์ด resolver ไม่ใช่การ์ด schema และทั้ง epic FG มีการ์ด schema
--   ใบเดียวคือ PYG-411 ใบนี้ → ถ้าไม่ใส่ตรงนี้ PYG-424 จะไปตันแล้วต้องขอ migration ใหม่
--
--   ทั้งสองคอลัมน์ nullable ไม่มี default ไม่แตะแถวเดิม → ถอดออกได้ไม่มีผลข้างเคียง
--   ถ้าทีมอยากให้ไปอยู่การ์ด PYG-424 แทน ลบสองบรรทัดนี้ (+ FK ข้อ 3) ได้เลย
-- ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄

-- ใครเป็นคนกดจอง — ต่างจาก patient_id ตรงที่ patient_id คือ "คนจ่ายเงิน/เจ้าของ booking"
-- ส่วน booked_by คือสมาชิกในกลุ่มที่ลงมือกดจริง (จองแทนกันได้)
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "booked_by" TEXT;

-- memberDetails ของ PYG-424: อาการ/รายละเอียดที่กรอกตอนจองแทน
-- ใช้ JSONB เพราะฟอร์มยังไม่นิ่ง (FG-4 ยังไม่มีดีไซน์) — พอฟิลด์นิ่งค่อยแตกเป็นคอลัมน์
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "member_details" JSONB;


-- ═══════════════════════════════════════════════════════════════════════════
-- 2. INDEXES
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 2.1 UNIQUE(group_id, user_id) — ตามการ์ดสั่งตรง ๆ ─────────────────────
-- คนเดียวมีได้แถวเดียวต่อกลุ่ม ไม่ว่าสถานะอะไร
-- ผลพลอยได้ที่สำคัญ: คนที่เคยออกแล้วกลับเข้ามาใหม่ = UPDATE status กลับเป็น ACTIVE
-- ไม่ใช่ INSERT แถวที่สอง → ประวัติไม่ซ้ำ และ PYG-417 (idempotent accept) ทำได้ง่าย
CREATE UNIQUE INDEX IF NOT EXISTS "family_group_members_group_id_user_id_key"
    ON "family_group_members" ("group_id", "user_id");

-- ─── 2.2 ★ หัวใจของ invariant "หนึ่งกลุ่มมี OWNER ที่ ACTIVE ได้คนเดียว" ────
-- partial unique index = unique เฉพาะแถวที่เข้าเงื่อนไข WHERE
-- ทำให้ INSERT/UPDATE ที่จะทำให้มี OWNER ACTIVE คนที่สอง พังทันทีที่ระดับดีบี
--
-- อันนี้แหละที่ทำให้ transferOwnership ปลอดภัย: ใน transaction เดียวต้อง
-- ลดคนเก่าเป็น MEMBER ก่อน แล้วค่อยเลื่อนคนใหม่เป็น OWNER
-- ถ้าเขียนโค้ดสลับลำดับ ดีบีจะ error ไม่ใช่ปล่อยให้ข้อมูลเพี้ยน
--
-- (ส่วน LAST_OWNER — กันเจ้าของคนสุดท้ายออกจากกลุ่ม — บังคับที่ดีบีไม่ได้
--  เพราะเป็นเงื่อนไข "ต้องมีอย่างน้อย 1" ซึ่ง index ทำไม่ได้ → เช็คใน PYG-412)
CREATE UNIQUE INDEX IF NOT EXISTS "family_group_members_one_active_owner_key"
    ON "family_group_members" ("group_id")
    WHERE "role" = 'OWNER' AND "status" = 'ACTIVE';

-- ค้น "กลุ่มทั้งหมดของฉัน" (myFamilyGroups ใน PYG-412)
CREATE INDEX IF NOT EXISTS "family_group_members_user_id_idx"
    ON "family_group_members" ("user_id");

-- ค้น "สมาชิกที่ยัง active ของกลุ่มนี้" — คิวรี่ที่ FamilyGroupGuard เรียกทุก request
CREATE INDEX IF NOT EXISTS "family_group_members_group_id_status_idx"
    ON "family_group_members" ("group_id", "status");

-- ─── 2.3 invites ───────────────────────────────────────────────────────────
-- ★ partial unique: "หนึ่งคำเชิญที่ PENDING ต่อ (กลุ่ม, อีเมล)" ตามการ์ด
-- lower(email) → เชิญ 'A@x.com' แล้วเชิญ 'a@x.com' ซ้ำไม่ได้
-- การ์ด PYG-416 บอก "re-invite replaces the live one" → resolver ต้อง REVOKE ใบเก่า
-- ก่อน INSERT ใบใหม่ ไม่งั้นชน index นี้ (ตั้งใจให้ชน จะได้ไม่มีลิงก์ 2 ใบใช้ได้พร้อมกัน)
CREATE UNIQUE INDEX IF NOT EXISTS "family_group_invites_pending_group_email_key"
    ON "family_group_invites" ("group_id", lower("email"))
    WHERE "status" = 'PENDING';

-- acceptInvite(token) → หา invite จาก sha256(token) ต้องเร็วและต้องไม่ซ้ำ
CREATE UNIQUE INDEX IF NOT EXISTS "family_group_invites_token_hash_key"
    ON "family_group_invites" ("token_hash");

-- หน้า "คำเชิญของกลุ่มนี้" + job กวาดใบหมดอายุ
CREATE INDEX IF NOT EXISTS "family_group_invites_group_id_status_idx"
    ON "family_group_invites" ("group_id", "status");

-- ─── 2.4 activity: index สำหรับ keyset pagination ──────────────────────────
-- PYG-421 ใช้ keyset บน created_at DESC
-- ★ ใส่ id DESC ต่อท้ายด้วย เพราะถ้าสองแถวมี created_at เท่ากันเป๊ะ
--   (เกิดง่ายมาก เพราะ activity เขียนใน transaction เดียวกัน → now() ค่าเดียวกัน)
--   keyset ที่ดูแค่ created_at จะข้ามแถวหาย หรือวนซ้ำแถวเดิม
--   → cursor ต้องเป็นคู่ (created_at, id) และ index ต้องเรียงตรงกัน
CREATE INDEX IF NOT EXISTS "family_group_activity_group_id_created_at_idx"
    ON "family_group_activity" ("group_id", "created_at" DESC, "id" DESC);

-- ─── 2.5 index บนคอลัมน์ใหม่ของตารางเดิม ───────────────────────────────────
-- "care recipients ทั้งหมดในกลุ่มนี้" (PYG-424) — partial เพราะแถวส่วนใหญ่ family_group_id
-- เป็น NULL (โปรไฟล์ส่วนตัว) ไม่ต้องเปลือง index กับมัน
CREATE INDEX IF NOT EXISTS "care_recipients_family_group_id_idx"
    ON "care_recipients" ("family_group_id")
    WHERE "family_group_id" IS NOT NULL;

-- "การจองทั้งหมดของกลุ่มนี้" — partial ด้วยเหตุผลเดียวกัน
CREATE INDEX IF NOT EXISTS "bookings_family_group_id_idx"
    ON "bookings" ("family_group_id")
    WHERE "family_group_id" IS NOT NULL;


-- ═══════════════════════════════════════════════════════════════════════════
-- 3. FOREIGN KEYS  (ON DELETE เลือกตามเหตุผลในคอมเมนต์แต่ละอัน)
-- ═══════════════════════════════════════════════════════════════════════════
-- ห่อ DO block ทุกอันเพราะ ALTER TABLE ADD CONSTRAINT ไม่มี IF NOT EXISTS
-- (ลอกแพตเทิร์นมาจาก 20260530000000_recover_ghost_tables)

-- ─── 3.1 family_groups.created_by → users ──────────────────────────────────
-- SET NULL: ลบคนสร้างทิ้ง กลุ่มต้องอยู่ต่อ (สมาชิกคนอื่นยังใช้งานอยู่)
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'family_groups_created_by_fkey') THEN
  ALTER TABLE "family_groups" ADD CONSTRAINT "family_groups_created_by_fkey"
    FOREIGN KEY ("created_by") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
END IF; END $$;

-- ─── 3.2 family_group_members ──────────────────────────────────────────────
-- group_id CASCADE: ลบกลุ่ม → สมาชิกหายตาม (AC A2 "delete cascades members")
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'family_group_members_group_id_fkey') THEN
  ALTER TABLE "family_group_members" ADD CONSTRAINT "family_group_members_group_id_fkey"
    FOREIGN KEY ("group_id") REFERENCES "family_groups" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
END IF; END $$;

-- user_id CASCADE: ลบ user → สมาชิกภาพหายตาม (ไม่มีเหตุผลให้เก็บ "สมาชิกที่ไม่มีตัวตน")
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'family_group_members_user_id_fkey') THEN
  ALTER TABLE "family_group_members" ADD CONSTRAINT "family_group_members_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
END IF; END $$;

-- invited_by SET NULL: ลบคนเชิญทิ้ง คนที่ถูกเชิญยังอยู่ในกลุ่มต่อได้
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'family_group_members_invited_by_fkey') THEN
  ALTER TABLE "family_group_members" ADD CONSTRAINT "family_group_members_invited_by_fkey"
    FOREIGN KEY ("invited_by") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
END IF; END $$;

-- ─── 3.3 family_group_invites ──────────────────────────────────────────────
-- group_id CASCADE: ลบกลุ่ม → คำเชิญค้างต้องหายด้วย
-- ★ สำคัญด้านความปลอดภัย: ถ้าปล่อยคำเชิญค้าง คนถือลิงก์เก่ากดรับได้ทีหลัง
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'family_group_invites_group_id_fkey') THEN
  ALTER TABLE "family_group_invites" ADD CONSTRAINT "family_group_invites_group_id_fkey"
    FOREIGN KEY ("group_id") REFERENCES "family_groups" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'family_group_invites_invited_by_fkey') THEN
  ALTER TABLE "family_group_invites" ADD CONSTRAINT "family_group_invites_invited_by_fkey"
    FOREIGN KEY ("invited_by") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'family_group_invites_accepted_by_fkey') THEN
  ALTER TABLE "family_group_invites" ADD CONSTRAINT "family_group_invites_accepted_by_fkey"
    FOREIGN KEY ("accepted_by") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
END IF; END $$;

-- ─── 3.4 family_group_activity ─────────────────────────────────────────────
-- group_id CASCADE: ลบกลุ่ม → ฟีดหายตาม (AC A2 "delete cascades ... activity")
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'family_group_activity_group_id_fkey') THEN
  ALTER TABLE "family_group_activity" ADD CONSTRAINT "family_group_activity_group_id_fkey"
    FOREIGN KEY ("group_id") REFERENCES "family_groups" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
END IF; END $$;

-- actor_id SET NULL: ★ ห้าม CASCADE เด็ดขาด
-- ฟีดกิจกรรมคือหลักฐานว่า "เกิดอะไรขึ้นในกลุ่ม" ถ้าลบ user แล้วประวัติหายตาม
-- = ลบบัญชีตัวเองแล้วลบร่องรอยตัวเองได้ทั้งหมด
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'family_group_activity_actor_id_fkey') THEN
  ALTER TABLE "family_group_activity" ADD CONSTRAINT "family_group_activity_actor_id_fkey"
    FOREIGN KEY ("actor_id") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
END IF; END $$;

-- ─── 3.5 care_recipients.family_group_id → family_groups ───────────────────
-- ★ SET NULL ไม่ใช่ CASCADE — เหตุผลเต็ม ๆ อยู่หัวไฟล์ข้อ 2
--   สรุปสั้น ๆ: โปรไฟล์ผู้รับบริการเป็นของ patient มาก่อนมีกลุ่ม
--   ลบกลุ่มแล้วไม่ควรลบคนไข้ทิ้ง และต้องไม่ทำให้ bookings.care_recipient_id หลุดเป็น NULL
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'care_recipients_family_group_id_fkey') THEN
  ALTER TABLE "care_recipients" ADD CONSTRAINT "care_recipients_family_group_id_fkey"
    FOREIGN KEY ("family_group_id") REFERENCES "family_groups" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
END IF; END $$;

-- ─── 3.6 bookings.family_group_id → family_groups ──────────────────────────
-- ★ SET NULL: edge case ในการ์ดบอกตรง ๆ ว่า
--   "delete group with active bookings-on-behalf → bookings keep history
--    (family_group_id set null), not blocked"
--   → ห้าม CASCADE (ลบประวัติการจอง) และห้าม RESTRICT (บล็อกการลบกลุ่ม)
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bookings_family_group_id_fkey') THEN
  ALTER TABLE "bookings" ADD CONSTRAINT "bookings_family_group_id_fkey"
    FOREIGN KEY ("family_group_id") REFERENCES "family_groups" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
END IF; END $$;

-- bookings.booked_by → users (คอลัมน์ "เกินการ์ด" ดูหมายเหตุข้อ 1.6)
-- SET NULL: ลบคนที่กดจองทิ้ง การจองยังอยู่ (patient_id ต่างหากที่เป็นเจ้าของ booking)
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bookings_booked_by_fkey') THEN
  ALTER TABLE "bookings" ADD CONSTRAINT "bookings_booked_by_fkey"
    FOREIGN KEY ("booked_by") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
END IF; END $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- 4. is_group_member()  —  ฟังก์ชันกลางที่ policy ทุกอันเรียกใช้
-- ═══════════════════════════════════════════════════════════════════════════
--
-- ★★ SECURITY DEFINER ตรงนี้ "ไม่ใช่ของแถม" — ถ้าไม่ใส่ RLS จะวนไม่รู้จบ ★★
--
-- ปัญหา: policy ของตาราง family_group_members เรียก is_group_member()
--        ซึ่งข้างในไป SELECT จาก family_group_members อีกที
--        → Postgres ต้องเช็ค policy ของ family_group_members ก่อน
--        → policy นั้นก็เรียก is_group_member() อีก → วนไม่จบ
--        อาการจริงคือ error "infinite recursion detected in policy for relation ..."
--
-- ทางแก้: SECURITY DEFINER ทำให้ฟังก์ชันรันด้วยสิทธิ์ของ "เจ้าของฟังก์ชัน"
--        ซึ่งเป็นเจ้าของตารางด้วย และเจ้าของตารางข้าม RLS ได้ (รีโปนี้ไม่มี
--        FORCE ROW LEVEL SECURITY ที่ไหนเลย) → SELECT ข้างในไม่ไปโดน policy ซ้ำ
--
-- SET search_path = public, pg_temp — บังคับคู่กับ SECURITY DEFINER เสมอ
-- ไม่งั้นคนที่เรียกฟังก์ชันสร้างตารางปลอมชื่อ users ใน schema ของตัวเอง
-- แล้วดัน search_path ให้ฟังก์ชันไปอ่านตารางปลอมนั้นด้วยสิทธิ์ owner ได้
--
-- STABLE = ผลลัพธ์คงที่ภายใน statement เดียว → planner เรียกซ้ำ ๆ ให้น้อยลง
--
-- หมายเหตุ: auth.uid() คืน uuid ส่วน users.supabase_uid เป็น text → ต้อง ::text
-- (ลอกจาก migration 20260424100000 / 20260803000000 ที่ใช้แพตเทิร์นเดียวกัน)
CREATE OR REPLACE FUNCTION public.is_group_member(p_group_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM family_group_members m
        JOIN users u ON u.id = m.user_id
        WHERE m.group_id = p_group_id
          AND m.status   = 'ACTIVE'
          AND u.supabase_uid = auth.uid()::text
    );
$$;

COMMENT ON FUNCTION public.is_group_member(UUID) IS
    'PYG-411: true ถ้า auth.uid() ปัจจุบันเป็นสมาชิก ACTIVE ของกลุ่มนี้. SECURITY DEFINER เพื่อตัด RLS recursion.';


-- ═══════════════════════════════════════════════════════════════════════════
-- 5. ENABLE ROW LEVEL SECURITY
-- ═══════════════════════════════════════════════════════════════════════════
-- ★ ย้ำ: backend ไม่ได้รับผลกระทบ
--   Prisma ต่อดีบีด้วย role postgres ซึ่งเป็นเจ้าของตาราง → ข้าม RLS ทั้งหมด
--   RLS ที่นี่คือ "ชั้นที่สอง" กันกรณีมีใครยิงตรงด้วย anon key ของ Supabase
--   (เช็คแล้วว่า payung-web ไม่ได้ .from() ตารางกลุ่มพวกนี้เลย — ปลอดภัย)
ALTER TABLE "family_groups"         ENABLE ROW LEVEL SECURITY;
ALTER TABLE "family_group_members"  ENABLE ROW LEVEL SECURITY;
ALTER TABLE "family_group_invites"  ENABLE ROW LEVEL SECURITY;
ALTER TABLE "family_group_activity" ENABLE ROW LEVEL SECURITY;

-- care_recipients เป็นตารางเดิมที่ยังไม่เคยเปิด RLS
-- เปิดได้อย่างปลอดภัยเพราะทางเข้าปัจจุบันคือ REST controller → Prisma → role postgres
-- แต่ต้องมี policy ให้ "เจ้าของโปรไฟล์" อ่านได้ด้วย ไม่ใช่แค่สมาชิกกลุ่ม (ดูข้อ 6.5)
ALTER TABLE "care_recipients"       ENABLE ROW LEVEL SECURITY;


-- ═══════════════════════════════════════════════════════════════════════════
-- 6. POLICIES
-- ═══════════════════════════════════════════════════════════════════════════
-- ★ ทุก policy เป็น SELECT อย่างเดียวโดยตั้งใจ
--   ไม่มี INSERT / UPDATE / DELETE policy = client เขียนตรงไม่ได้เลย
--   การเปลี่ยนแปลงทุกอย่างต้องผ่าน backend เพราะต้องเขียน activity row
--   ใน transaction เดียวกัน (AC A5) ซึ่ง client ทำเองไม่ได้
--
-- ห่อ DO block ทุกอันเพราะ CREATE POLICY ไม่มี IF NOT EXISTS

-- ─── 6.1 family_groups ─────────────────────────────────────────────────────
DO $$ BEGIN
    CREATE POLICY "family_groups_select_members" ON "family_groups"
        FOR SELECT USING (is_group_member("id"));
EXCEPTION WHEN duplicate_object THEN
    RAISE NOTICE 'PYG-411: policy family_groups_select_members มีอยู่แล้ว — ข้าม';
END $$;

-- ─── 6.2 family_group_members ──────────────────────────────────────────────
-- สมาชิกในกลุ่มเห็นรายชื่อสมาชิกคนอื่นในกลุ่มเดียวกันได้
DO $$ BEGIN
    CREATE POLICY "family_group_members_select_members" ON "family_group_members"
        FOR SELECT USING (is_group_member("group_id"));
EXCEPTION WHEN duplicate_object THEN
    RAISE NOTICE 'PYG-411: policy family_group_members_select_members มีอยู่แล้ว — ข้าม';
END $$;

-- ─── 6.3 family_group_invites — ★ เปิด RLS แต่ "ไม่สร้าง policy เลย" ────────
-- RLS เปิดแล้วไม่มี policy = ปฏิเสธทุกแถวสำหรับทุก role ที่ไม่ใช่เจ้าของตาราง
-- ตั้งใจให้เป็นแบบนี้ เพราะตารางนี้เก็บ token_hash + อีเมลผู้ถูกเชิญ
-- ถ้าให้ client อ่านได้แม้แต่เจ้าของกลุ่ม ก็เท่ากับแจก hash ออกไปฟรี ๆ
-- การอ่านคำเชิญทั้งหมดต้องผ่าน resolver ของ PYG-416 ที่ select เฉพาะฟิลด์ที่ปลอดภัย

-- ─── 6.4 family_group_activity ─────────────────────────────────────────────
-- PYG-421: "Member-only (is_group_member)"
DO $$ BEGIN
    CREATE POLICY "family_group_activity_select_members" ON "family_group_activity"
        FOR SELECT USING (is_group_member("group_id"));
EXCEPTION WHEN duplicate_object THEN
    RAISE NOTICE 'PYG-411: policy family_group_activity_select_members มีอยู่แล้ว — ข้าม';
END $$;

-- ─── 6.5 care_recipients ───────────────────────────────────────────────────
-- ★ policy นี้ต้อง "กว้างกว่า" ตารางอื่น เพราะตารางนี้มีข้อมูลเดิมอยู่แล้ว
--   เงื่อนไขแรก (patient_id = ตัวเอง) คือการรักษาพฤติกรรมเดิมไว้ทั้งหมด
--   ถ้าใส่แค่ is_group_member() โปรไฟล์ส่วนตัวที่ family_group_id เป็น NULL
--   จะอ่านไม่ได้เลย = ของเดิมพังเงียบ ๆ
DO $$ BEGIN
    CREATE POLICY "care_recipients_select_owner_or_group" ON "care_recipients"
        FOR SELECT USING (
            "patient_id" IN (SELECT id FROM users WHERE supabase_uid = auth.uid()::text)
            OR ("family_group_id" IS NOT NULL AND is_group_member("family_group_id"))
        );
EXCEPTION WHEN duplicate_object THEN
    RAISE NOTICE 'PYG-411: policy care_recipients_select_owner_or_group มีอยู่แล้ว — ข้าม';
END $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- 7. สิ่งที่ไฟล์นี้ "ไม่" ทำ (ตั้งใจ)
-- ═══════════════════════════════════════════════════════════════════════════
--   ✗ ไม่เพิ่ม family_group_activity เข้า supabase_realtime publication
--     PYG-428 (Config, Sam เป็นเจ้าของ) ระบุว่า realtime เป็น "optional" และให้
--     ตัดสินใจที่การ์ดนั้น — ตรงนี้เตรียม RLS ไว้ให้พร้อมแล้ว เหลือแค่ ALTER PUBLICATION
--
--   ✗ ไม่ใส่ soft cap จำนวนสมาชิก / care recipient ต่อกลุ่ม
--     PYG-428 §11.5 บอกให้ "confirm value with product before enabling"
--
--   ✗ ไม่มี trigger อัปเดต updated_at
--     ตารางเดิมในรีโปนี้ (เช่น care_recipients) ก็ใช้ DEFAULT now() แล้วให้ app เขียนเอง
--     ทำตามของเดิมเพื่อให้ `prisma db pull` ไม่มี diff
--
--   ✗ ไม่ backfill ข้อมูลเดิม — booking/care_recipient ที่มีอยู่ทั้งหมด
--     family_group_id = NULL ซึ่งแปลว่า "ไม่เกี่ยวกับกลุ่ม" ถูกต้องตามความหมายอยู่แล้ว
