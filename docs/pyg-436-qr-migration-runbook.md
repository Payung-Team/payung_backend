# PYG-436 — Runbook: deploy / verify / rollback ของตาราง QR

**เอกสารนี้เขียนให้ Sam ใช้ตอนกด deploy** — การ์ด PYG-436 ระบุว่า Sam เป็น deploy gate
ตัว SQL ถูกเขียนไปแล้วใน PYG-434 / PYG-435 ไฟล์นี้คือส่วนที่เหลือของการ์ด:
"ทดสอบบน staging + rollback plan"

| | |
|---|---|
| การ์ด | PYG-436 · การ์ดแม่ PYG-433 · Epic PYG-350 |
| Migration ที่เกี่ยวข้อง | `20260828000000_add_job_sessions` (PYG-434)<br>`20260829000000_add_job_scan_events` (PYG-435) |
| ทดสอบเมื่อ | 2026-08-29 |
| ทดสอบบน | PostgreSQL 17.11 ใน Docker (ดีบีเปล่า ใช้แล้วทิ้ง) — **ไม่ได้แตะดีบีจริงเลย** |
| ทดสอบกับ commit | `9499ecf` บน branch `Tawan` |
| วิธีทดสอบ | replay migration ทั้ง 41 ไฟล์จากศูนย์ แล้วตรวจโครงสร้าง / invariant / RLS / rollback |

---

## 1. สรุปสั้นที่สุด

| AC ของการ์ด | ผล |
|---|---|
| `migrate deploy` สะอาด | ✅ ผ่าน — 41/41 migration apply ได้ ไม่มี error |
| rollback ได้ | ✅ ผ่าน — ถอยแล้ว re-apply กลับมาได้ครบ 11 constraint / 7 index เท่าเดิม |
| in-flight booking เดิมไม่มี session (ข้าม + บันทึกไว้) | ✅ บันทึกไว้ที่หัวข้อ 6 พร้อม query นับจำนวนที่กระทบ |

⚠️ **สิ่งที่เอกสารนี้ยังไม่ครอบคลุม — อ่านก่อนติ๊ก AC:**
การ์ดเขียนว่า *"ทดสอบบน staging"* แต่ที่ทำจริงคือทดสอบบน **PostgreSQL 17 ในเครื่อง**
ที่ replay migration ทั้ง 41 ไฟล์จากศูนย์ ไม่ใช่ Supabase staging ตัวจริง
สองอย่างนี้ต่างกันตรง: Supabase มี schema `auth` / `storage` / role `anon` กับ
`authenticated` ของจริง ซึ่งเครื่องทดสอบไม่มี (ผมจำลอง role ขึ้นมาเองในข้อ R2)
→ **การรันบน staging จริงยังต้องทำโดย Sam** ตอนกด deploy ตามหัวข้อ 3-4

⚠️ **มี 1 เรื่องที่ต้องรู้ก่อน deploy** และ **1 บั๊กเก่าที่เจอระหว่างทาง** — อ่านหัวข้อ 2 กับ 7

---

## 2. ⚠️ deploy รอบนี้ไม่ได้มีแค่ 2 ไฟล์ของ QR

ตอนนี้ดีบี dev มี migration ค้างอยู่ **3 ไฟล์** ไม่ใช่ 2:

```
20260824000000_family_group_management     <-- PYG-411 ค้างมาก่อนแล้ว ไม่ใช่ของ QR
20260828000000_add_job_sessions            <-- PYG-434
20260829000000_add_job_scan_events         <-- PYG-435
```

`prisma migrate deploy` จะ apply **ทั้งสามไฟล์เรียงกันในคำสั่งเดียว** ไม่มีวิธีเลือก apply
เฉพาะบางไฟล์ ถ้ายังไม่พร้อมปล่อย family group ต้องคุยกันก่อนกด

ลำดับบังคับ (Prisma เรียงตามชื่อโฟลเดอร์ให้เองอยู่แล้ว แต่ต้องรู้ไว้):
`job_scan_events` มี FK ชี้ไป `job_sessions` → **job_sessions ต้องมาก่อนเสมอ**

---

## 3. ก่อน deploy

```bash
npx prisma migrate status
```

ต้องเห็น 3 ไฟล์ข้างบนอยู่ใต้ "have not yet been applied"

> **หมายเหตุเรื่อง drift ที่จะเห็น:** `migrate status` จะบอกว่ามี 8 migration
> อยู่ในดีบีแต่ไม่มีในโฟลเดอร์ (`20260504000000_add_kyc_rejection_fields` ฯลฯ)
> อันนี้เป็นเรื่องเก่าที่มีอยู่ก่อนแล้ว **ไม่ได้เกิดจากการ์ด QR** และไม่บล็อก deploy
> เพราะ Prisma apply เฉพาะไฟล์ที่มีในโฟลเดอร์แต่ยังไม่มีในดีบีเท่านั้น

**ตั้ง ENV ให้ครบก่อน deploy** — ไม่งั้นแอปจะไม่ยอมบูตหลัง deploy:

```bash
# สร้างค่าใหม่
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

แล้วใส่ `QR_TOKEN_SECRET=<ค่าที่ได้>` ลง `.env` ของ environment นั้น
(ค่าอื่นมี default ใช้ได้เลย ไม่ต้องตั้ง — ดู `.env.example`)

⚠️ **เปลี่ยนค่า `QR_TOKEN_SECRET` ทีหลัง = QR ของ booking ทุกใบใช้ไม่ได้ทันที**
ถ้าจำเป็นต้องเปลี่ยน ต้องเขียน script คำนวณ `token_hash` ใหม่ทุกแถวด้วย

---

## 4. หลัง deploy — query ตรวจ

รันทีละก้อน ผลที่คาดไว้เขียนไว้ใต้แต่ละอัน

**4.1 ตารางขึ้นครบ**

```sql
SELECT tablename FROM pg_tables
WHERE tablename IN ('job_sessions','job_scan_events') ORDER BY 1;
```
→ ต้องได้ 2 แถว

**4.2 index ที่การ์ดสั่งไว้ มีจริง**

```sql
SELECT tablename, indexname FROM pg_indexes
WHERE tablename IN ('job_sessions','job_scan_events') ORDER BY 1,2;
```
→ ต้องได้ 7 แถว โดยต้องมี `job_sessions_booking_id_key` (unique — "QR ใบเดียวต่อ booking")
และ `job_scan_events_booking_id_idx`

**4.3 constraint ครบ**

```sql
SELECT rel.relname, con.conname, con.contype
FROM pg_constraint con JOIN pg_class rel ON rel.oid = con.conrelid
WHERE rel.relname IN ('job_sessions','job_scan_events')
ORDER BY 1, 3, 2;
```
→ ต้องได้ **11 แถว** (CHECK 6 · FK 3 · PK 2)

**4.4 ★ RLS ปิดตายจริง — ข้อนี้สำคัญที่สุด**

```sql
SELECT c.relname, c.relrowsecurity AS rls_on,
       (SELECT count(*) FROM pg_policies p WHERE p.tablename = c.relname) AS policies
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname='public' AND c.relname IN ('job_sessions','job_scan_events');
```
→ ต้องได้ `rls_on = t` และ `policies = 0` **ทั้งสองตาราง**

`policies = 0` ไม่ใช่ความผิดพลาด แต่คือสิ่งที่ตั้งใจ: RLS เปิดแล้วไม่มี policy
= ปฏิเสธทุกแถวสำหรับทุก role ที่ไม่ใช่เจ้าของตาราง สองตารางนี้เก็บ `token_hash`
ถ้าอ่านผ่าน anon key ได้ = แจกลายนิ้วมือของ QR ออกไปให้เอาไปเทียบแบบ offline
การอ่าน QR ต้องผ่าน resolver `jobQr()` เท่านั้น

> ถ้าเห็น `policies > 0` แปลว่ามีคนไปเพิ่ม policy ทีหลัง — **ให้หยุดแล้วถาม** ก่อนใช้งานต่อ

**4.5 ควันขึ้นหรือเปล่า (smoke test)**

จองงานใหม่ 1 ใบผ่านแอป แล้ว:
```sql
SELECT b.id, s.status, s.valid_from, s.valid_until
FROM bookings b LEFT JOIN job_sessions s ON s.booking_id = b.id
ORDER BY b.created_at DESC LIMIT 1;
```
→ `status` ต้องเป็น `PENDING` และมี `valid_from`/`valid_until`
ถ้า `status` เป็น NULL แปลว่าใบ QR ไม่ถูกสร้าง → ระบบเช็คอินจะพังทั้งงานใบนั้น

---

## 5. Rollback

### เมื่อไหร่ถึงควรถอย

ถอยได้ปลอดภัยถ้า **ยังไม่มีใครสแกน QR จริง** (คือเพิ่ง deploy แล้วเจอปัญหาทันที)

⚠️ **ถ้ามีคนใช้งานไปแล้ว การถอย = ลบข้อมูลถาวร**
- `job_sessions` หาย → งานที่กำลังทำอยู่จะเช็คอิน/เช็คเอาท์ผ่าน QR ไม่ได้เลย
- `job_scan_events` หาย → ร่องรอยการสแกนทั้งหมดหายไปด้วย (ใช้สอบข้อพิพาทไม่ได้อีก)
- แต่ **`job_events` (หลักฐานการทำงานจริง) ไม่หาย** เพราะเป็นคนละตาราง —
  ทดสอบยืนยันแล้ว งานที่เช็คอินไปแล้วยังมีหลักฐานครบ

ถ้าอยากเก็บ audit ไว้ก่อนถอย:
```sql
CREATE TABLE job_scan_events_backup_20260829 AS SELECT * FROM job_scan_events;
```

### คำสั่งถอย

★ **ลำดับสำคัญ** — `job_scan_events` มี FK ชี้ไป `job_sessions` ต้องลบตัวหลังก่อน
ห่อ transaction ไว้ ถ้ากลางทางพังจะไม่เหลือสภาพครึ่ง ๆ กลาง ๆ

```sql
BEGIN;

DROP TABLE IF EXISTS "job_scan_events";
DELETE FROM "_prisma_migrations"
 WHERE migration_name = '20260829000000_add_job_scan_events';

DROP TABLE IF EXISTS "job_sessions";
DELETE FROM "_prisma_migrations"
 WHERE migration_name = '20260828000000_add_job_sessions';

COMMIT;
```

### หลังถอย

1. `npx prisma migrate status` → ต้องเห็น 2 ไฟล์นั้นกลับมาอยู่ใต้ "not yet been applied"
2. **ต้อง deploy โค้ดเวอร์ชันก่อน `73af6de` ควบคู่กันด้วย** ไม่งั้นแอปจะพังตอนสร้าง booking
   (โค้ดจะเรียก `prisma.jobSession.create()` ใส่ตารางที่ไม่มีแล้ว)
   → **ถอยดีบีอย่างเดียวไม่พอ ต้องถอยโค้ดด้วย**
3. ถ้าจะ apply ใหม่: `npx prisma migrate deploy` ได้เลย ทดสอบแล้วว่ากลับมาครบเหมือนเดิม

### รันซ้ำได้ไหม

ได้ ทดสอบแล้ว — migration ทั้งสองไฟล์ใช้ `IF NOT EXISTS` กับ `DO ... EXCEPTION` ทุกจุด
รันทับของที่มีอยู่แล้วจะขึ้น NOTICE ว่า "มีอยู่แล้ว — ข้าม" ไม่มี error
และโครงสร้างไม่ซ้ำซ้อน (ยังได้ 11 constraint / 7 index เท่าเดิม)
มีประโยชน์ตอน deploy พังกลางคันแล้วต้องรันซ้ำ

---

## 6. AC ข้อ 3 — booking เก่าที่ไม่มีใบ QR (ตั้งใจข้าม)

การ์ดเขียนว่า *"in-flight booking เดิมไม่มี session (prototype = ข้าม, บันทึกไว้)"*
→ **ไม่ backfill โดยตั้งใจ** บันทึกไว้ที่นี่

**นับจำนวนที่กระทบ (รันหลัง deploy):**

```sql
SELECT count(*) AS booking_ที่ไม่มี_qr
FROM bookings b
LEFT JOIN job_sessions s ON s.booking_id = b.id
WHERE s.id IS NULL
  AND b.status IN ('confirmed','in_progress');
```

**ผลกระทบจริง:** booking กลุ่มนี้ **ยังเช็คอิน/เช็คเอาท์ได้ตามปกติ** ผ่าน mutation เดิม
เพราะประตูสแกน (`assertScanned` ใน `monitoring.service.ts`) ผูกเงื่อนไขไว้กับ
"งานใบนี้มี QR ไหม" ไม่ใช่ "วันไหน" — งานที่ไม่มี QR จึงใช้ทางเดิมได้เหมือนเดิม
งานใหม่ทุกใบที่จองหลัง deploy จะมี QR และถูกบังคับให้สแกน

→ **ไม่ต้องทำอะไรกับข้อมูลเก่า** ปล่อยให้งานกลุ่มนั้นทยอยจบไปเอง

ถ้าวันหนึ่งจำเป็นต้อง backfill จริง ๆ ห้ามเขียนเป็น SQL ล้วน
เพราะต้องคำนวณ `token_hash` ด้วย `QR_TOKEN_SECRET` และ `valid_from`/`valid_until`
ด้วยสูตรเดียวกับ `JobQrService` → ต้องเขียนเป็น script ฝั่งแอป

---

## 7. เรื่องที่เจอระหว่างทดสอบ (ไม่ใช่ของการ์ดนี้ แต่ต้องบอก)

### 7.1 🐛 replay migration จากศูนย์พังมาตั้งแต่ 2026-08-03

ตอน replay ทั้ง 41 ไฟล์ลงดีบีเปล่า มันพังที่ `20260803000000_add_job_events_monitoring` (PYG-352):

```
Database error code: 3F000
ERROR: schema "storage" does not exist
```

**สาเหตุ:** migration นั้นมี `EXCEPTION WHEN undefined_table OR insufficient_privilege`
ครอบไว้แล้ว (คนเขียนตั้งใจรองรับ local postgres ที่ไม่ใช่ Supabase — เขียนคอมเมนต์ไว้ชัด)
แต่ error จริงคือ `invalid_schema_name` (3F000) ซึ่ง**คนละอย่างกับ** `undefined_table` (42P01)
→ handler เลยดักไม่ติด

และ `00000000000000_supabase_shadow_shim` ก็เขียนไว้ในคอมเมนต์ตัวเองว่า
*"Verified by grepping all 27 pre-existing migrations (as of 2026-07-16)"* พร้อมกำชับว่า
*"if a future migration references something else, extend this file"* —
migration ของ PYG-352 มาทีหลัง (2026-08-03) และไม่มีใครขยาย shim ตาม

**ผลกระทบวันนี้:**
- `prisma migrate dev` ใช้ไม่ได้ทั้งทีม (shadow DB replay พัง) — น่าจะเป็นเหตุผลนึง
  ที่ทีมเขียน migration มือกันมาตลอด
- สร้าง environment ใหม่จากศูนย์ไม่ได้
- **ไม่กระทบ deploy ครั้งนี้** เพราะดีบีจริงผ่าน migration นั้นไปนานแล้ว
  และ 3 ไฟล์ที่ค้างอยู่ไม่มีไฟล์ไหนแตะ `storage`

**ทางแก้ที่เล็กที่สุด:** แค่ให้ schema `storage` มีอยู่ (เปล่า ๆ ก็พอ) —
พอมี schema แล้ว `EXCEPTION WHEN undefined_table` เดิมจะดักได้ถูกต้องเอง
ทดสอบยืนยันแล้ว: `CREATE SCHEMA storage;` บรรทัดเดียว แล้ว replay ผ่านครบ 41/41

⚠️ **แก้ไฟล์ shim เดิมตรง ๆ ไม่ได้** เพราะ Prisma เก็บ checksum ไว้ —
แก้ไฟล์ที่ apply ไปแล้ว = `migrate deploy` ครั้งหน้าพัง
ต้องออกเป็น migration ใหม่ชื่อ `00000000000001_supabase_storage_shim`
(ชื่อเรียงก่อน 20260803 → replay รอบหน้าจะทำงานถูกลำดับ)

**ยังไม่ได้ทำในการ์ดนี้** เพราะอยู่นอกขอบเขต PYG-436 — ควรเปิดการ์ดแยก

### 7.2 การ์ดเขียนว่า "enum" — ทำครบแล้วฝั่งโค้ด แต่ฝั่งดีบีเป็น TEXT + CHECK (ขอ review)

การ์ดระบุ `+enum JobSessionStatus` และ `+enum ScanAction/ScanResult`

**ฝั่งโค้ด: ครบทั้ง 3 ตัวแล้ว** เป็น GraphQL enum จริง (โผล่ใน `schema.gql`)
| enum | ออกตอน | ใช้ที่ฟิลด์ |
|---|---|---|
| `ScanAction` | PYG-435 | `JobScanResult.action`, `JobQr.nextAction` |
| `ScanResult` | PYG-435 | `JobScanResult.result` |
| `JobSessionStatus` | **PYG-436 (การ์ดนี้)** | `JobQr.status`, `JobScanResult.sessionStatus` |

`JobSessionStatus` เพิ่งเพิ่มในการ์ดนี้ — 434/435 ส่ง status ออกไปเป็น `String` เฉย ๆ
ตอนนี้เป็นจังหวะที่แก้ได้ถูกที่สุดเพราะ FE (PYG-437/438) ยังไม่เริ่มเขียน ยังไม่มีใครพัง
พร้อมกันนั้นเปลี่ยน `JobQr.nextAction` จาก `String` เป็น `ScanAction` ด้วย
เพื่อไม่ให้มีคำศัพท์สองชุดสำหรับเรื่องเดียวกัน

⚠️ **FE ต้องรู้: 3 ฟิลด์นี้เปลี่ยนชนิดใน schema แล้ว** (`String` → enum)
ค่าที่ส่งจริงเหมือนเดิมทุกตัวอักษร แต่ codegen จะออก type ใหม่ให้

**ฝั่งดีบี: ตั้งใจใช้ TEXT + CHECK ไม่ใช่ PG enum**

เหตุผล:
- ให้เหมือน `job_sessions.status`, `job_events.event_type`, `bookings.status`
  ที่อยู่ข้าง ๆ กัน — ทั้งหมดเป็น TEXT + CHECK อยู่แล้ว
- PG enum เพิ่มค่าใหม่ต้อง `ALTER TYPE ... ADD VALUE` ซึ่งรันใน transaction เดียว
  กับ migration อื่นไม่ได้ในหลายเวอร์ชันของ Postgres
- `ScanResult` มี 11 ค่าและมีแนวโน้มจะเพิ่ม → TEXT + CHECK ยืดหยุ่นกว่า

ทดสอบยืนยันแล้วว่า CHECK กัดจริงทุกข้อ (ดูหัวข้อ 8)

ถ้าทีมอยากได้ PG enum จริง ๆ บอกได้ แก้ไม่ยากตอนนี้ (ยังไม่มีข้อมูลในตาราง)

---

## 8. รายการทดสอบที่รันไปแล้ว

รันบน PostgreSQL 17.11 ในดีบีเปล่าใน Docker หลัง replay ครบ 41 ไฟล์

### โครงสร้าง
| # | ทดสอบ | ผล |
|---|---|---|
| 1 | replay 41 migration จากศูนย์ | ✅ (ต้องมี schema `storage` ก่อน — ดู 7.1) |
| 2 | คอลัมน์ `job_sessions` 10 ตัว ชนิด/nullable ถูกต้อง | ✅ |
| 3 | คอลัมน์ `job_scan_events` 10 ตัว ชนิด/nullable ถูกต้อง | ✅ |
| 4 | index 7 อัน ครบตามที่การ์ดสั่ง | ✅ |
| 5 | constraint 11 อัน (CHECK 6 · FK 3 · PK 2) | ✅ |
| 6 | `schema.prisma` ตรงกับ SQL เขียนมือ (`prisma migrate diff`) | ✅ ไม่มี drift ของสองตารางนี้เลย |

### invariant (ของที่ควรถูกปฏิเสธ ต้องถูกปฏิเสธ)
| # | ทดสอบ | ผล |
|---|---|---|
| J1 | สร้าง session ปกติ | ✅ ผ่าน |
| J2 | booking เดิมสร้าง QR ใบที่สอง | ✅ ถูกปฏิเสธ (23505) |
| J3 | เผลอเขียน token ดิบลง `token_hash` | ✅ ถูกปฏิเสธ (23514) |
| J4 | `token_hash` เป็น hex ตัวใหญ่ | ✅ ถูกปฏิเสธ (23514) |
| J5 | `status` นอกรายการ (เช่น `CANCELLED`) | ✅ ถูกปฏิเสธ (23514) |
| J6 | ช่วงเวลากลับหัว (`valid_until <= valid_from`) | ✅ ถูกปฏิเสธ (23514) |
| J7 | `booking_id` ที่ไม่มีจริง | ✅ ถูกปฏิเสธ (23503) |
| S1 | บันทึกสแกนสำเร็จ | ✅ ผ่าน |
| S2 | บันทึกสแกน token มั่ว (session/booking = NULL) | ✅ ผ่าน |
| S3 | `result` code นอกสัญญา | ✅ ถูกปฏิเสธ (23514) |
| S4 | `action` นอกรายการ | ✅ ถูกปฏิเสธ (23514) |
| S5 | เผลอเขียน token ดิบลง audit | ✅ ถูกปฏิเสธ (23514) |

### พฤติกรรมตอนลบข้อมูล
| # | ทดสอบ | ผล |
|---|---|---|
| D1 | ลบ booking → `job_sessions` หายตาม (CASCADE) | ✅ |
| D2 | ลบ booking → `job_scan_events` **ยังอยู่** โดย FK กลายเป็น NULL | ✅ |

D2 คือข้อที่ตั้งใจออกแบบให้ต่างจากตารางอื่นในรีโป: audit log ต้องไม่หายไปพร้อม
ของที่มันบันทึกไว้ ไม่งั้น "ลบของทิ้ง" จะกลายเป็นวิธี "ลบร่องรอย" ไปในตัว

### ความปลอดภัย
| # | ทดสอบ | ผล |
|---|---|---|
| R1 | RLS เปิด + policy = 0 ทั้งสองตาราง | ✅ |
| R2 | role ที่มี `GRANT SELECT` แล้ว ยังอ่านได้ 0 แถว | ✅ |

R2 คือการพิสูจน์ว่า "RLS ไม่มี policy = ปฏิเสธทุกแถว" ทำงานจริง
ไม่ใช่แค่ตั้งค่าไว้เฉย ๆ

### rollback
| # | ทดสอบ | ผล |
|---|---|---|
| B1 | รัน rollback SQL → ตารางหายทั้งสอง | ✅ |
| B2 | `job_events` (ของ PYG-352) ไม่ได้รับผลกระทบ | ✅ |
| B3 | `migrate status` เห็น 2 ไฟล์กลับมา pending | ✅ |
| B4 | `migrate deploy` ซ้ำ → กลับมาครบ 11 constraint / 7 index | ✅ |
| B5 | รัน `migration.sql` ทับของที่มีอยู่ → ไม่มี error ไม่ซ้ำซ้อน | ✅ |

---

## 9. วิธีรันชุดทดสอบนี้ซ้ำ

```bash
docker run -d --rm --name payung_qr_test \
  -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test -e POSTGRES_DB=payung_test \
  -p 5434:5432 postgres:17

docker exec payung_qr_test psql -U test -d payung_test -c "CREATE SCHEMA IF NOT EXISTS storage;"

DATABASE_URL="postgresql://test:test@localhost:5434/payung_test" npx prisma migrate deploy
```

⚠️ **ต้องใส่ `DATABASE_URL=` นำหน้าคำสั่งเสมอ** ไม่งั้นจะไปโดนดีบีจริง
เช็คก่อนได้ด้วย `migrate status` — บรรทัด `Datasource "db"` ต้องขึ้นว่า `localhost:5434`

เสร็จแล้วเก็บกวาด: `docker rm -f payung_qr_test`
