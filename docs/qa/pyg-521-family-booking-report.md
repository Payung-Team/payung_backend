# PYG-521 · QA จองแทนในกลุ่ม: ชื่อ-นามสกุลแก้ไม่ได้ + shortcut autofill + คนนอกกลุ่มจองไม่ได้

- การ์ด: PYG-521 (QA) · การ์ดแม่: PYG-492 · ขึ้นกับ: PYG-516 (#76), PYG-517 (#77, #80), PYG-519 (FE)
- Commit ที่ทดสอบ: `origin/dev` @ `27cfac3` (หลัง #95/#96)
- รัน: 2026-10-03 · Created By / Execute By: Wasan. R
- Spec: `test/pyg521-family-booking.e2e-spec.ts` · harness: `test/support/pyg521-e2e.ts`
- **ผล: ตามการ์ด 7/7 PASS · เคสเพิ่มจากการอ่านโค้ด 0/3 PASS (พบบั๊ก 3 ข้อ)**

**รันจริงแค่ไหน:** บูต `FamilyGroupModule` ตัวจริง (ดึง Booking/Payment/Monitoring/Notification ตามมา) ยิง GraphQL ผ่าน guard/resolver/service จริง ต่อ Postgres 17 ทิ้งได้ใน Docker (DDL จาก `schema.prisma` + CHECK/partial unique index ของ family_group_members + seed `service_price_catalog`) mock แค่ Supabase auth / Omise / Email ไม่มีการเรียกภายนอกจริง

**ไม่ครอบ (FE):** การแสดงผลบนหน้าจอ เช่น ช่องชื่อเป็น read-only จริงไหม ปุ่ม shortcut กดแล้วเติมฟอร์มไหม ที่นี่ตรวจ "สัญญาของ API" ที่หน้าจอพึ่ง (`nameLocked`, `name`, `hasProfile`, `details`, การปฏิเสธ `patientName`)

## 1. ผลตามตารางในการ์ด

| TC | เคส (การ์ด) | ผล | หลักฐาน |
|---|---|---|---|
| _01 | เปิดขั้นกรอกข้อมูลผู้รับบริการ → เห็นสมาชิก ACTIVE ครบรวมเจ้าของ | PASS | กลุ่ม = เจ้าของ + A, B (ACTIVE) + คน LEFT + คน REMOVED → `groupBookingRecipients` คืน {เจ้าของ, A, B} พอดี ทั้งมุมเจ้าของและมุมสมาชิก · `name` = ชื่อบัญชี (first + last) · `nameLocked = true` ทุกคน |
| _02 | กดชื่อสมาชิกที่มีข้อมูล → เติมครบ ชื่อ read-only | PASS (API) | `hasProfile: true` · `details` = ที่อยู่ / โรค / ยา / แพ้ยา / คำแนะนำ ตรงกับโปรไฟล์ในกลุ่ม · `nickname` มา |
| _03 | กดชื่อสมาชิกที่ยังไม่มีข้อมูล → ชื่อล็อก ช่องอื่นว่าง | PASS (API) | `hasProfile: false`, `details: null`, `name` = ชื่อบัญชี |
| _04 | แก้ที่อยู่/ข้อมูลสุขภาพแล้วจอง → บันทึกค่าใหม่ | PASS | ใบจอง: `locationAddress` = ค่าใหม่ · `patientProfile` (member_details) = ค่าใหม่ทั้ง 4 ช่อง · `care_recipient_id` = โปรไฟล์เดิมในกลุ่ม · `patient_name` = ชื่อบัญชี |
| _05 | ยิง API ส่ง `patientName` ชื่ออื่น → ชื่อบนใบจอง / หน้าผู้ดูแล = ชื่อบัญชี | PASS | ส่ง `patientName` → **ปฏิเสธ** `PATIENT_NAME_NOT_ALLOWED` ไม่มีใบจอง/โปรไฟล์ถูกสร้าง (ตาม PYG-516 ที่เลือก "ปฏิเสธ" แทน "เพิกเฉย") · จองแบบไม่ส่ง → `patientName` / `careRecipientName` และ `caregiverBooking.careRecipientName` ฝั่งผู้ดูแล = ชื่อบัญชี |
| _06 | จองให้คนที่ออกจากกลุ่มแล้ว (`memberUserId` และ `careRecipientId`) → ไม่ได้ | PASS | ทั้ง LEFT และ REMOVED: `memberUserId` → `MEMBER_NOT_FOUND` · `careRecipientId` (โปรไฟล์ในกลุ่มของเขา) → `RECIPIENT_NOT_IN_GROUP` · ส่งทั้งคู่ → `MEMBER_NOT_FOUND` · ไม่มีใบจอง/โปรไฟล์เพิ่ม · ไม่อยู่ในรายชื่อ shortcut |
| _07 | คนนอกกลุ่มเรียก query รายชื่อ → ไม่ได้ | PASS | คนนอก และคนที่ออกไปแล้ว → `NOT_A_MEMBER`, `data: null` · response ไม่มีชื่อสมาชิกหรือข้อมูลสุขภาพ · ไม่ล็อกอิน → ไม่ได้ข้อมูล |

## 2. บั๊กที่พบ (เคสเพิ่มจากการอ่านโค้ด)

ทั้ง 3 ข้ออยู่ใน `BookingService.createBookingOnBehalf` / `resolveGroupPatientProfile` — **ชื่อและข้อมูลที่ใบจองใช้ ไม่ได้มาจากที่เดียวกับที่ shortcut (PYG-517) โชว์** ชื่อมาจากบัญชีเฉพาะสาขา ③ (สมาชิกยังไม่มีโปรไฟล์เลย) สาขาอื่นใช้ `care_recipients.name`

| # | เคส | คาดหวัง | ที่ได้จริง | ผลกระทบบน prod (อ่านอย่างเดียว 2026-10-03) |
|---|---|---|---|---|
| **B1** (_X1) | สมาชิกมีโปรไฟล์ในกลุ่มที่ชื่อไม่ตรงบัญชี (ข้อมูลก่อน PYG-516 ที่คนจองพิมพ์ชื่อเอง) | ใบจอง + หน้าผู้ดูแล = ชื่อบัญชี (เหมือนปุ่ม shortcut) | ปุ่มโชว์ชื่อบัญชี แต่ใบจองและหน้าผู้ดูแลได้ **ชื่อในโปรไฟล์** ("คุณแม่ (ชื่อที่เคยพิมพ์เอง)") — "กดชื่อหนึ่ง ใบจองขึ้นอีกชื่อ" ซึ่งโค้ดเองเตือนไว้ว่าห้ามเกิด | โปรไฟล์ในกลุ่ม 3 ใบ **2 ใบชื่อไม่ตรงบัญชี** (สมาชิก ACTIVE) · ใบจองกลุ่มที่ยังเปิด (pending/accepted/confirmed) **4 ใบ** ชื่อไม่ตรงบัญชี |
| **B2** (_X2) | สมาชิกไม่มีโปรไฟล์ในกลุ่ม ไม่มีใบ `is_self` แต่มีโปรไฟล์ส่วนตัวของคนอื่น (เช่น "คุณยาย") | ใบจองเป็นชื่อสมาชิก ข้อมูลสุขภาพว่าง | สาขา ② คัดลอก **โปรไฟล์คุณยาย** ทั้งชื่อและโรค (`อัลไซเมอร์`) มาเป็นโปรไฟล์ในกลุ่มของสมาชิก — ผู้ดูแลไปดูแลผิดคนตามข้อมูลผิดคน · สาเหตุ: `orderBy is_self desc` แต่ไม่กรอง `is_self = true` (ฝั่ง PYG-517 กรองแล้ว) | สมาชิก ACTIVE **3 คน** อยู่ในสภาพนี้ (จองแทนเมื่อไหร่โดนทันที) |
| **B3** (_X3) | สมาชิกมีใบ `is_self` แต่ยังไม่เคยยินยอม `disclose_to_family_group` | shortcut ไม่โชว์ข้อมูล และการจองต้องไม่ทำให้กลุ่มเห็นข้อมูลสุขภาพ | ก่อนจอง shortcut ซ่อนถูกต้อง แต่จองแล้วสาขา ② **คัดลอกใบ `is_self` เข้ากลุ่ม** → สมาชิกคนอื่นเห็น `conditions: ['HIV']` ผ่าน `groupBookingRecipients` ทันที · `assertOnBehalfConsents` ดูแค่ "ถอนแล้วหรือยัง" ไม่ได้ดู "ยินยอมแล้วหรือยัง" (ยังไม่ตอบ ≠ ยินยอม ตามหลักที่ PYG-517 ใช้) — **ประเด็น PDPA ม.26** | โปรไฟล์ในกลุ่มที่เกิดจากการคัดลอก (`self_reported`) **3 ใบ** — ยังไม่ได้ตรวจกับตารางความยินยอมว่าใบไหนคัดลอกโดยไม่มีความยินยอม |

### ข้อเสนอการแก้ (ยังไม่ได้แก้ — รอตัดสินใจ)
- **B1:** ทุกสาขาใช้ `resolveMemberAccountName(patientId)` เป็นชื่อบนใบจอง (สาขา `careRecipientId` ด้วย) · ส่วนชื่อในโปรไฟล์ที่ไม่ตรง: ซิงก์ตอนจอง หรือ backfill ครั้งเดียว (ต้องมี dry-run/rollback) · ใบที่เปิดอยู่ 4 ใบตัดสินใจแยก
- **B2:** สาขา ② กรอง `is_self: true` ให้ตรงกับ PYG-517
- **B3:** สาขา ② คัดลอกเฉพาะเมื่อสมาชิก "ยินยอม" `disclose_to_family_group` เวอร์ชันปัจจุบัน (`grantedCurrentUserIds`) ไม่งั้นไปสาขา ③ (ชื่อจากบัญชี ข้อมูลสุขภาพตามที่คนจองกรอก)

## 3. เรื่องโครงสร้างเทสที่เจอระหว่างทาง

- **e2e ทุกตัวที่บูต GraphQL พังบน `dev` ปัจจุบัน** — `Undefined type error … "gender" of "MemberDetailsInput"` เพราะ `tsconfig` เปิด `isolatedModules` → ts-jest แปลงทีละไฟล์ → `GenderLabel` (type alias จากไฟล์อื่น, เพิ่มใน #90) ได้ `design:type = Object` · แอปจริง (`nest start` = tsc ทั้งโปรแกรม) **ไม่พัง** · แก้ใน `test/jest-e2e.json` ให้ ts-jest ใช้ `isolatedModules: false` (care-log e2e เดิมยังผ่าน 28/28)
- harness ของ PYG-427 (PR #59 ยังไม่ merge) ใช้ตรง ๆ ไม่ได้แล้ว: ผู้ใช้ต้องมี first/last name (ด่าน PYG-499) และผู้ดูแลต้องเปิดตารางว่าง (PYG-524) → ทำ `test/support/pyg521-e2e.ts` แยก ไม่แตะไฟล์ของ #59
- `test/jest-e2e.json` ไม่มีบน `dev` (อยู่ใน #59) — PR นี้เพิ่มเข้ามา ถ้า #59 merge ทีหลังจะชนไฟล์นี้ ให้ใช้เวอร์ชันของ PR นี้

## 4. วิธีรันซ้ำ

```bash
docker run -d --name pyg521-qa-db -e POSTGRES_PASSWORD=qa -e POSTGRES_DB=qa -p 127.0.0.1:5436:5432 postgres:17
DATABASE_URL=x npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script \
  | docker exec -i pyg521-qa-db psql -U postgres -d qa -q
# + CHECK/partial unique index ของ family_group_members และ seed service_price_catalog (ดู §ด้านบน)
PYG521_DATABASE_URL=postgresql://postgres:qa@127.0.0.1:5436/qa npm run test:e2e -- pyg521
```
ไม่ตั้ง `PYG521_DATABASE_URL` → skip ทั้งไฟล์ · ใน CI (`CI` ตั้งไว้) แต่ไม่ตั้ง → ล้ม · host ไม่ใช่ localhost → throw

| ตรวจ | ผล |
|---|---|
| `tsc -p tsconfig.json` | 21 error เท่า `dev` (ไม่มีในไฟล์ใหม่) |
| `npm run test:e2e` ไม่ตั้ง env | 1 suite skipped (10), care-log 28 passed |
| `CI=1` ไม่ตั้ง env | ล้ม พร้อมข้อความ `PYG521_DATABASE_URL ไม่ได้ตั้งค่าใน CI` |
| ต่อ Docker DB | 7 passed (การ์ด) · 3 failed (B1–B3) |
