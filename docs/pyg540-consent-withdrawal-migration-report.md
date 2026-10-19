# PYG-540 — ถอนความยินยอม + หน้าความยินยอมของฉัน

## รายงานความต้องการด้าน migration

| | |
|---|---|
| วันที่ | 2026-09-22 |
| การ์ดแม่ | PYG-465 · ต่อยอดจาก PYG-473 (ตาราง) / PYG-538 (onboarding) / PYG-474 (register) / PR #73 (`setConsent` ของ Wasan) |
| **ฟีเจอร์ใน PR นี้ต้องรัน migration ไหม** | **ไม่ต้อง** — ทำงานครบผ่าน backend |
| **แตะ `prisma/schema.prisma` ไหม** | **ไม่แตะ** |
| **แตะ `prisma/migrations/` ไหม** | **ไม่แตะ** |
| **มีงาน migration ที่ "ควรทำต่อ" ไหม** | **มี 1 ชุด** (หัวข้อ 3) — ปิดช่องอ่านตรงผ่าน Supabase ของสมาชิกกลุ่มครอบครัว |

> สรุปสั้นที่สุดสำหรับคนรีวิว: **PR นี้ deploy ได้ทันทีโดยไม่ต้องทำอะไรกับดีบี**
> หัวข้อ 3 คือ "ชั้นป้องกันที่สอง" ที่แนะนำให้ทีมตัดสินใจและให้ Sam รันแยกภายหลัง
> ไฟล์นี้ **ไม่ได้สร้าง migration ให้** ตามกฎทีม (อะไรที่เกี่ยวกับ migration ให้เขียนเป็นรายงาน)

---

## 1. การ์ดขออะไร

ถอนความยินยอมแล้ว **ต้องมีผลจริง** ไม่ใช่แค่ธงในตาราง:

| ถอนข้อ | ผลที่ต้องเกิด |
|---|---|
| `sensitive_health_data` | `onboardingCompleted` = false (PYG-538) และจองใหม่ไม่ได้ |
| `disclose_to_caregiver` | จองใหม่ไม่ได้ · งานที่รับแล้วไม่กระทบ |
| `disclose_to_family_group` | สมาชิกกลุ่มไม่เห็นข้อมูลผู้รับบริการอีก |
| `marketing` | หยุดส่งอีเมลข่าวสาร |

---

## 2. ทำไมฟีเจอร์นี้ไม่ต้อง migrate

ทุกอย่างใช้ของที่มีอยู่แล้วจาก PYG-473:

* **ตาราง `user_consents`** เป็น append-only อยู่แล้ว (trigger บล็อก UPDATE)
  → ถอน = `INSERT` แถวใหม่ `granted = false` · ให้กลับ = `INSERT` แถวใหม่ `granted = true`
  ไม่มีคอลัมน์ใหม่ ไม่มีตารางใหม่
* **"สถานะปัจจุบัน" = แถวล่าสุดของแต่ละข้อ** อ่านผ่าน index ที่มีอยู่แล้ว
  `idx_user_consents_latest (user_id, consent_type, granted_at DESC)`
* **ค่า `source = 'settings'`** อยู่ใน `CONSENT_SOURCE` ของโค้ดตั้งแต่ PYG-472
  (คอลัมน์ `source` เป็น TEXT ไม่มี CHECK)
* ผลของการถอนทุกข้อบังคับที่ **backend** (Prisma ต่อด้วย role เจ้าของตาราง = ไม่ผ่าน RLS):

| ผล | บังคับที่ |
|---|---|
| จองใหม่ไม่ได้ | `BookingService` — ทั้ง REST `POST /api/v1/bookings` และ GraphQL `createBookingOnBehalf` |
| กลุ่มไม่เห็นข้อมูล | `groupCareRecipients` (ซ่อนโปรไฟล์ · เจ้าของยังเห็นของตัวเอง) · `groupBookingRecipients` (PYG-517 — ไม่อยู่ในรายการ "จองให้ใคร" · เจ้าของยังเห็นตัวเอง) · `groupBookings` (ซ่อนนัดหมาย · เจ้าของและคนกดจองยังเห็น) · `familyGroupActivity` (ลบชื่อ/วันเวลาออกจาก metadata · เจ้าของและคนกดจองยังเห็น) · `createBookingOnBehalf` (จองแทนไม่ได้) |
| หยุดอีเมลข่าวสาร | `EmailService.sendMarketingEmail` — ทางเดียวที่ส่งอีเมลการตลาดได้ ตรวจ consent ก่อนส่งทุกครั้ง |

**ข้อมูลเดิมไม่เปลี่ยนเลย** — ตอนนี้ `user_consents` ยังว่างทั้งระบบ (ยังไม่มีใครถอน)
และตรรกะ "บล็อกเฉพาะคนที่ถอน" (แถวล่าสุด `granted = false`) ทำให้ผู้ใช้เดิมที่ยังไม่เคยถูกถาม
ใช้งานได้ตามเดิมทุกอย่าง

---

## 3. ช่องที่ยังเปิดอยู่ — ต้องแก้ที่ RLS (= migration) ⚠

### 3.1 ปัญหา

migration `20260824000000_family_group_management` เปิด RLS ให้ **สมาชิก ACTIVE ของกลุ่มอ่านตรง**
ผ่าน Supabase (PostgREST / supabase-js ด้วย anon key + JWT ของตัวเอง) ได้ 2 ตาราง:

| policy | อ่านอะไรได้ |
|---|---|
| `care_recipients_select_owner_or_group` | **แถวเต็มของโปรไฟล์ที่แชร์เข้ากลุ่ม รวมคอลัมน์สุขภาพทั้งหมด** |
| `family_group_activity_select_members` | `metadata` ของกิจกรรม "จองแทน" (ชื่อผู้รับบริการ วันที่ เวลา) |

ตัวกรองใน backend ของ PR นี้ **ไม่ครอบทางนี้** เพราะการอ่านตรงไม่ผ่าน backend เลย

* payung-web **ไม่ได้** อ่านตารางพวกนี้ตรง (เช็คแล้ว ไม่มี `.from('care_recipients')` / `.from('family_group_activity')`)
  → ผู้ใช้ทั่วไป **ไม่เห็น** ข้อมูลที่ถอนแล้ว
* แต่สมาชิกกลุ่มที่ตั้งใจยิง API ของ Supabase เอง **ยังอ่านได้** — ซึ่งขัดกับที่เราสัญญาไว้ในประกาศ
  ว่าถอนแล้วสมาชิกกลุ่มจะไม่เห็นข้อมูลอีก

### 3.2 SQL ที่เสนอ (ยังไม่ได้สร้างเป็นไฟล์ migration — ให้ทีมตัดสินใจ)

ชื่อที่เสนอ: `prisma/migrations/<ts>_pyg540_family_disclosure_rls/migration.sql`

```sql
-- PYG-540 — RLS เคารพการถอนความยินยอม disclose_to_family_group
-- ⚠ เขียนมือ ห้ามรัน prisma migrate dev / db push — Sam รัน `prisma migrate deploy` เท่านั้น
-- idempotent: CREATE OR REPLACE / DROP POLICY IF EXISTS ก่อน CREATE

-- ─── 1. ผู้ใช้คนนี้ "ถอน" ความยินยอมข้อนี้ไว้ไหม (แถวล่าสุด granted = false) ───────────
-- ★ SECURITY DEFINER: RLS ของ user_consents ให้อ่านได้แค่แถวของตัวเอง
--   แต่ policy ต้องดูแถวของ "เจ้าของโปรไฟล์" ซึ่งเป็นคนอื่น
-- ★ ไม่มีแถว = false (ไม่บล็อก) — ความหมายเดียวกับ ConsentService.withdrawnUserIds ฝั่ง backend
CREATE OR REPLACE FUNCTION public.consent_withdrawn(p_user_id TEXT, p_type TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT COALESCE((
        SELECT NOT c.granted
        FROM user_consents c
        WHERE c.user_id = p_user_id
          AND c.consent_type = p_type
        ORDER BY c.granted_at DESC
        LIMIT 1
    ), false);
$$;

-- ─── 2. กิจกรรมจองแทนของเจ้าของข้อมูลที่ถอนไว้ (และผู้อ่านไม่ใช่เจ้าของเอง) ─────────────
-- ★ SECURITY DEFINER เช่นกัน — ถ้า subquery รันด้วยสิทธิ์ผู้อ่าน RLS ของ bookings
--   จะซ่อนแถวแล้ว NOT EXISTS กลายเป็น true = เปิดให้อ่าน (fail-open) ซึ่งตรงข้ามกับที่ต้องการ
CREATE OR REPLACE FUNCTION public.booking_family_disclosure_withdrawn(p_booking_id TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT COALESCE((
        SELECT public.consent_withdrawn(cr.patient_id, 'disclose_to_family_group')
               AND cr.patient_id NOT IN (
                   SELECT id FROM users WHERE supabase_uid = auth.uid()::text
               )
        FROM bookings b
        JOIN care_recipients cr ON cr.id = b.care_recipient_id
        WHERE b.id::text = p_booking_id
    ), false);
$$;

-- ─── 3. care_recipients: สมาชิกกลุ่มไม่เห็นโปรไฟล์ของคนที่ถอน (เจ้าของยังเห็นของตัวเอง) ──
DROP POLICY IF EXISTS "care_recipients_select_owner_or_group" ON "care_recipients";
CREATE POLICY "care_recipients_select_owner_or_group" ON "care_recipients"
    FOR SELECT USING (
        "patient_id" IN (SELECT id FROM users WHERE supabase_uid = auth.uid()::text)
        OR (
            "family_group_id" IS NOT NULL
            AND is_group_member("family_group_id")
            AND NOT public.consent_withdrawn("patient_id", 'disclose_to_family_group')
        )
    );

-- ─── 4. family_group_activity: ซ่อนแถวจองแทนของคนที่ถอน ───────────────────────────────
-- ★ RLS ซ่อน "คอลัมน์" ไม่ได้ จึงซ่อนทั้งแถวสำหรับการอ่านตรง
--   (backend ใช้วิธีลบ metadata แทน เพื่อไม่ให้ pagination พัง — คนละทางกัน แต่ผลคือไม่เห็นเหมือนกัน)
-- ★ คนกดจอง (actor) ยังเห็นแถวของตัวเอง — ตรงกับ backend (เป็นคู่สัญญา เห็นใบนี้ในประวัติการจองอยู่แล้ว)
DROP POLICY IF EXISTS "family_group_activity_select_members" ON "family_group_activity";
CREATE POLICY "family_group_activity_select_members" ON "family_group_activity"
    FOR SELECT USING (
        is_group_member("group_id")
        AND (
            "actor_id" IN (SELECT id FROM users WHERE supabase_uid = auth.uid()::text)
            OR NOT (
                "target_type" = 'BOOKING'
                AND "target_id" IS NOT NULL
                AND public.booking_family_disclosure_withdrawn("target_id")
            )
        )
    );

-- ─── 5. post-assertion ─────────────────────────────────────────────────────────────
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
                   AND tablename = 'care_recipients'
                   AND policyname = 'care_recipients_select_owner_or_group') THEN
        RAISE EXCEPTION 'PYG-540: policy care_recipients_select_owner_or_group หายไป';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
                   AND tablename = 'family_group_activity'
                   AND policyname = 'family_group_activity_select_members') THEN
        RAISE EXCEPTION 'PYG-540: policy family_group_activity_select_members หายไป';
    END IF;
END $$;
```

### 3.3 ROLLBACK (มือ)

คืน policy เดิมจาก migration `20260824000000_family_group_management` (ข้อ 6.5 และ policy ของ activity) แล้ว:

```sql
DROP FUNCTION IF EXISTS public.booking_family_disclosure_withdrawn(TEXT);
DROP FUNCTION IF EXISTS public.consent_withdrawn(TEXT, TEXT);
DELETE FROM "_prisma_migrations" WHERE migration_name = '<ts>_pyg540_family_disclosure_rls';
```

### 3.4 ผลกระทบกับข้อมูลเดิม / ระบบเดิม

| เรื่อง | ผล |
|---|---|
| ข้อมูล | **ไม่แตะแถวไหนเลย** — เปลี่ยนแค่ "ใครอ่านอะไรได้" |
| backend | **ไม่กระทบ** — Prisma ต่อด้วย role เจ้าของตาราง ข้าม RLS อยู่แล้ว |
| payung-web | **ไม่กระทบ** — ไม่ได้อ่านสองตารางนี้ตรง |
| ผู้ใช้ตอนนี้ | **ไม่มีใครถูกซ่อนทันที** — `user_consents` ยังว่าง และไม่มีแถว = ไม่บล็อก |
| ประสิทธิภาพ | ฟังก์ชันรันต่อแถวที่ policy ตรวจ · กลุ่มหนึ่งมีสมาชิกไม่เกิน 10 คน และมี index `idx_user_consents_latest` รองรับตรงตัว |

### 3.5 Dry-run ก่อนรัน (อ่านอย่างเดียว)

```sql
SELECT to_regprocedure('public.consent_withdrawn(text,text)');            -- ควรเป็น NULL (ยังไม่มี)
SELECT policyname, qual FROM pg_policies
 WHERE tablename IN ('care_recipients', 'family_group_activity');          -- ดู policy เดิมก่อนแทนที่
SELECT count(*) FROM user_consents
 WHERE consent_type = 'disclose_to_family_group' AND granted = false;      -- จำนวนแถวที่ถอน ณ ตอนรัน
```

---

## 4. ข้อสังเกตที่ไม่ใช่ migration (แจ้งไว้ให้ทีมตัดสินใจ)

1. **`privacy@payung.app` ยังไม่มีอยู่จริง** (ตามหมายเหตุในการ์ด) — หน้า "ความเป็นส่วนตัว" แสดงอีเมลนี้แล้ว
   ต้องตั้งกล่องจดหมายก่อนเปิดใช้ ไม่งั้นคำขอใช้สิทธิ์ของผู้ใช้จะไม่มีใครได้รับ
2. **นัดหมายที่ส่งคำขอไปก่อนถอน แต่ผู้ดูแลยังไม่รับ** (สถานะ `pending` / `unmatched`)
   ยังเดินต่อได้ตามเดิม (การ์ดกำหนดแค่ "จองใหม่ไม่ได้" และ "งานที่รับแล้วไม่กระทบ")
   ถ้าต้องการให้ถอน `disclose_to_caregiver` แล้วยกเลิกคำขอที่ค้างอยู่ด้วย ต้องเปิดการ์ดแยก
3. **ข้อกำหนดการใช้บริการ / ประกาศความเป็นส่วนตัว ถอนผ่านหน้าตั้งค่าไม่ได้** — เป็นเงื่อนไขของการมีบัญชี
   (ถ้าเปิดปุ่มถอนจะได้แค่ธงในตารางโดยไม่มีผลจริง ซึ่งการ์ดเตือนว่าแย่กว่าไม่มีปุ่ม)
   ผู้ใช้ที่ไม่ต้องการใช้บริการต่อให้ขอลบบัญชีทาง `privacy@payung.app` — สิทธิ์ลบข้อมูลเป็นคนละการ์ด
4. **ผู้ใช้ที่สมัครก่อนมีระบบ consent / สมัครผ่าน Google** ยังไม่มีแถวใน `user_consents`
   → ระบบถือว่า "ยังไม่เคยตอบ" (ไม่บล็อก) · การขอย้อนหลังเป็นงานของ PYG-504
5. **FE มี query `groupBooking` (รายละเอียดนัดของกลุ่ม) แต่ backend ยังไม่มี resolver นี้**
   → ตอนนี้ยังไม่มีช่องรั่ว · ใครทำ resolver นี้ต้องใช้เกณฑ์เดียวกับ `groupBookings`
   (ซ่อนนัดของเจ้าของที่ถอน `disclose_to_family_group` ยกเว้นเจ้าของเองและคนกดจอง)
6. **จองแทนคนอื่นที่ถอนความยินยอมไว้** → error `CONSENT_WITHDRAWN` ใช้ข้อความกลาง ๆ และ **ไม่แนบ `consentType`**
   (ว่าใครถอนความยินยอมเรื่องอะไรเป็นข้อมูลส่วนตัวของเขา) · จองให้ตัวเองถึงจะบอกข้อที่ถอน + ทางแก้
7. **⚠ `groupCareRecipients` บน dev (commit 3bab161) ส่ง "โปรไฟล์ส่วนตัว" พร้อมข้อมูลสุขภาพของสมาชิก ACTIVE ทุกคน**
   ให้สมาชิกทุกคนในกลุ่ม — PYG-540 ซ่อนเฉพาะคนที่ "กดถอน" · คนที่ยังไม่เคยตอบข้อ `disclose_to_family_group`
   (= เกือบทุกคนตอนนี้) ยังถูกเปิดเผยข้อมูลสุขภาพส่วนตัวให้กลุ่มโดยไม่เคยให้ความยินยอม
   ซึ่งขัดกับหมายเหตุของ PYG-517 เอง ("ห้ามดึงโปรไฟล์ส่วนตัว ... PDPA ม.26") → **แนะนำเปิดการ์ดแยก**
   ให้โปรไฟล์ส่วนตัวแสดงในกลุ่มเฉพาะคนที่ "ยินยอม" แล้ว (ไม่ใช่แค่ "ไม่ได้ถอน")
8. **ต่อยอดจาก PR #73 (Wasan)** — `ConsentService.setConsent` ยังเป็นทางเขียนทางเดียว ไม่ได้เขียนซ้ำ
   ที่เพิ่ม: `withdraw` / `grant` ตรวจ role + ข้อที่ถอนไม่ได้ก่อนเรียก `setConsent` ·
   `myConsents` คืนทุกข้อของ role (รวมข้อที่ยังไม่เคยตอบ) + ฟิลด์ `answered` / `required` / `withdrawable`
   ⚠ พฤติกรรมที่เปลี่ยนจาก #73: ถอนข้อกำหนดการใช้บริการ / ประกาศความเป็นส่วนตัว ผ่าน mutation
   ตอนนี้ได้ `CONSENT_NOT_WITHDRAWABLE` (เดิมเขียนแถว granted = false ที่ไม่มีผลอะไร)
   ⚠ ด่านจองที่ #73 เลื่อนไว้ (เพราะผู้รับบริการ 68 คนยังไม่เคยถูกถาม) ใส่แล้วในรูป **"บล็อกเฉพาะคนที่กดถอน"**
   ไม่มีแถว = ผ่าน → ผู้ใช้เดิมทั้ง 68 คนจองได้ตามปกติ ไม่มีใครถูกล็อกทันที
