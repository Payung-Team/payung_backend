# PYG-513 · QA รูปโปรไฟล์ผู้ดูแล: อัปโหลด → รีวิว → แสดงผล

- การ์ด: PYG-513 (QA) · การ์ดแม่: PYG-488 · ขึ้นกับ: PYG-506 (Done), PYG-507 (Done), **PYG-508 (To Do)**, PYG-509 (QA Test), PYG-510 (QA Test), **PYG-511 (In Progress)**, PYG-512 (Done)
- Commit ที่ทดสอบ: `origin/dev` @ `b1770e7`
- รัน: 2026-10-04 · Created By / Execute By: Wasan. R
- Spec: `test/pyg513-profile-photo.e2e-spec.ts` · harness: `test/support/pyg513-e2e.ts`
- **ผล: 33 เคส — PASS 23 · FAIL 7 · รอ PYG-508 อีก 3 (todo)** · ในโค้ดเทส 7 เคสที่ FAIL เป็น `it.failing` ชุดเทสจึงเขียว (แก้แล้วเทสจะแดง → เปลี่ยนกลับเป็น `it`)

**สรุปสั้น:** ส่วนอัปโหลด (PYG-507) ผ่านครบ · ส่วนรีวิว **ทดสอบไม่ได้เพราะ PYG-508 ยังไม่มีใน backend** (ไม่มี mutation อนุมัติ/ปฏิเสธรูป ไม่มีคิว ไม่มี field ให้ผู้ดูแลดูสถานะ) · ส่วนแสดงผลผ่านเฉพาะกรณี "ยังไม่มีรูปที่อนุมัติ" — พอมีรูปที่อนุมัติแล้ว ผลค้นหา / ใบจอง / public profile ส่ง **storage path ดิบ** ออกมา (PYG-509 ยังไม่ครบ) · บั๊ก PYG-547 ทำซ้ำได้ และกระทบ **หน้าสถานะ KYC ของผู้ดูแลเองด้วย** ไม่ใช่แค่หน้าแอดมิน

**รันจริงแค่ไหน:** บูต Auth + Identity(KYC) + Admin + Search + CaregiverPublic + Booking ตัวจริง ยิง REST `POST /api/v1/profile/photo` (multer จริง), `GET /api/v1/caregivers/:id/public` และ GraphQL ที่เหลือ ต่อ Postgres 17 ทิ้งได้ใน Docker · mock แค่ Supabase (auth + **Storage แบบ in-memory ที่เก็บ bytes จริงที่ backend ส่งขึ้น**) / Omise / Email

**ไม่ครอบ:**
- **หน้าจอ FE** (PYG-510 crop/อัปโหลด, PYG-511 หน้าแอดมิน, PYG-512 แสดงรูป + QR Check-in) — ที่นี่ตรวจค่าที่ API ส่งให้ FE
- **"URL หมดอายุจริง"** — Storage เป็นของปลอม ตรวจได้แค่ว่า backend ขอ signed URL ด้วยอายุเท่าไร (_13b) การหมดอายุจริงต้องลองกับ Supabase จริง
- สถานะ Approved / Rejected **ตั้งตรงลง DB** (ไม่มี mutation ให้เรียก) ตามรูปแบบที่ PYG-507 ออกแบบ: `users.avatar_url` = path ของรูปที่อนุมัติ + แถว `kyc_documents` เป็น `approved` — ถ้า PYG-508 ทำออกมาคนละแบบ เคส _07/_07b/_09 ต้องปรับ

## 1. อัปโหลด (PYG-507)

| TC | เคส | ผล | หลักฐาน |
|---|---|---|---|
| _01 | ผู้ดูแลอัปโหลด | PASS | 201 `reviewStatus: pending` · `kyc_documents` 1 แถว (`profile_photo`, `pending`) · `users.avatar_url` ยัง NULL · `kycStatus` ยัง `verified` · `photoUrl` เป็น signed URL |
| _01b | อัปโหลดซ้ำตอนยัง pending | PASS | คิวเหลือใบเดียว (ใบใหม่) ไฟล์ใบเก่าถูกลบจาก bucket |
| _01c | บัญชี role ผู้ดูแลที่ยังไม่มีแถว `caregivers` | PASS | 403 "ไม่พบโปรไฟล์ผู้ดูแลของบัญชีนี้" ไม่มีไฟล์ค้างใน bucket — ดูข้อสังเกต §5 |
| _02 | role อื่นเปลี่ยนรูป (ผู้รับบริการ / แอดมิน / Super Admin) | PASS 3/3 | `reviewStatus: approved` · `users.avatar_url` = path ใหม่ทันที · ไม่มีแถว `kyc_documents` · `me.avatarUrl` เป็น signed URL |
| _02b | role อื่นเปลี่ยนรูปซ้ำ | PASS | ไฟล์เดิมถูกลบ เหลือรูปล่าสุดใบเดียว |
| _03 | ไฟล์ใน bucket ไม่มี EXIF / GPS (ผู้ดูแล + ผู้รับบริการ) | PASS 2/2 | ต้นฉบับมี Exif + XMP (พิกัด) + motion photo ต่อท้าย → ไฟล์ที่เก็บไม่มีทั้งสามอย่าง · ICC profile ยังอยู่ |
| _04 | ไฟล์ที่ไม่รับ | PASS | PNG → 415 · PNG อ้างเป็น `image/jpeg` → 415 · เกิน 5 MB → 413 · ไม่แนบไฟล์ → 400 · ไม่มี token → 401 · ไม่มีแถว/ไฟล์เกิด |
| _05 | `updateProfile(avatarUrl)` ถูกปฏิเสธ (ผู้ดูแล + ผู้รับบริการ) | PASS 2/2 | error ชี้ไป `POST /api/v1/profile/photo` · `avatar_url` ไม่เปลี่ยน |

## 2. ตาราง "การแสดงผลต่อผู้ใช้ทั่วไป" — ผลค้นหา / ใบจอง / public profile

ดูจาก `searchCaregivers.avatarUrl`, `myBooking.caregiver.avatarUrl`, `GET /caregivers/:id/public → avatar_url` ในมุมผู้จอง

| TC | แถวในการ์ด | ผล | หลักฐาน |
|---|---|---|---|
| _06 | Pending ไม่มีรูปเดิม → Placeholder | PASS | ทั้ง 3 ที่เป็น `null` |
| _07 | Pending มีรูปเดิมที่อนุมัติ → รูปเดิม | PASS* | ทั้ง 3 ที่ชี้รูปเดิม ไม่ใช่รูปใหม่ (*แต่ออกเป็น path ดิบ — ดู _07b) |
| **_07b** | รูปที่อนุมัติแล้วต้องเป็น signed URL | **FAIL** | ทั้ง 3 ที่ได้ `"<userId>/profile-approved-….jpg"` = **storage path ดิบ** ไม่ใช่ signed URL → `<img>` โหลดไม่ขึ้น และขัดข้อ "ไม่มี response ไหนมี storage path ดิบ" |
| **_08** | Approved → รูปใหม่ | **FAIL** | schema ไม่มี mutation เกี่ยวกับรูปโปรไฟล์เลย (PYG-508 ยังไม่ทำ) |
| _08b | แอดมินอนุมัติแล้ว 3 ที่เป็นรูปใหม่ | รอ PYG-508 | — |
| _09 | Rejected มีรูปเดิม → รูปเดิม | PASS* | ทั้ง 3 ที่ยังเป็นรูปเดิม (*สถานะ rejected ตั้งตรงลง DB) |
| _10 | Rejected ไม่มีรูปเดิม → Placeholder | PASS* | ทั้ง 3 ที่เป็น `null` (*เช่นกัน) |
| **_10b** | ผู้ดูแลเห็นเหตุผลที่ถูกปฏิเสธ | **FAIL** | `Caregiver` / `KycStatusPayload` / `Query` ไม่มี field สถานะหรือเหตุผลของรูป — FE (PYG-510) จำ "รออนุมัติ" ไว้ใน `localStorage` ของเครื่องที่อัปโหลดเท่านั้น เปิดเครื่องอื่นไม่เห็น |
| _10c | แอดมินปฏิเสธพร้อมเหตุผล + ลง `kyc_reviews` | รอ PYG-508 | — |

**_07b รายละเอียด:** `AvatarUrlService.resolve` (sign path → URL) ถูกเรียกแค่ `User.avatarUrl` (`me`), สมาชิก/ฟีดกลุ่มครอบครัว และฝั่งผู้ดูแลมองผู้รับบริการ · จุดที่ **ผู้จองมองผู้ดูแล** ยังส่ง `users.avatar_url` ออกตรง ๆ: `search.service.ts` (`avatarUrl: row.avatar_url`), `booking.service.ts` (`caregiver.user.avatarUrl` หลายจุด), `caregiver-public.service.ts` (`avatar_url`), `saved-caregivers.service.ts`
- **ยังไม่เกิดบน prod** เพราะยังไม่มีทางที่ `avatar_url` ของผู้ดูแลจะเป็น storage path (prod อ่านอย่างเดียว 2026-10-04: ผู้ดูแลที่ `avatar_url` เป็น path = 0, role อื่น = 8) — **จะเกิดทันทีที่ PYG-508 เริ่มอนุมัติรูป** ถ้า PYG-509 ยังไม่ปิดจุดเหล่านี้

## 3. เพิ่มเติม

| TC | เคส | ผล | หลักฐาน |
|---|---|---|---|
| _11 | ผู้ดูแล `verified` เปลี่ยนรูป → `kycStatus` ยัง `verified` | PASS | ยัง `verified` + `isSearchable` + ค้นหาเจอ |
| **_11b** | …และต้องโผล่ในคิวแอดมิน | **FAIL** | `adminKycList(status: pending)` ไม่มีผู้ดูแลคนนี้ — คิวกรองด้วย `caregivers.kyc_status` อย่างเดียว ไม่ดู `kyc_documents.review_status` |
| _11c | ใช้ `approveKyc` / `rejectKyc` เดิมกับรูปนี้ | PASS (ยืนยันว่าใช้ไม่ได้) | 409 "Cannot approve KYC: already verified" · รูปยัง `pending` · `avatar_url` ยัง NULL = **ที่มาของ PYG-546** |
| _11d | `kycStatus` ยัง `verified` หลังอนุมัติ/ปฏิเสธรูป | รอ PYG-508 | — |
| _12 | (ตัวเทียบ) ยังไม่อัปโหลดรูป → แอดมินเปิดรายละเอียด KYC | PASS | เห็นบัตรเป็น signed URL · `fileUrl` ว่าง (ไม่คืน path ดิบ) |
| **_12b** | อัปโหลดรูปแล้ว → แอดมินเปิดรายละเอียด KYC (KYC `verified` / `pending`) | **FAIL 2/2** | `adminKycDetail` → 403 "เอกสารนี้ไม่ตรงกับเจ้าของ — ไม่สามารถออกลิงก์ได้" ทั้งก้อน ไม่เห็นเอกสารใดเลย = **PYG-547** |
| **_12c** | อัปโหลดรูปแล้ว → ผู้ดูแลเปิดหน้าสถานะ KYC ของตัวเอง | **FAIL** | `kycStatus` → 403 ข้อความเดียวกัน — **การ์ด PYG-547 ยังไม่ได้พูดถึงฝั่งนี้** |
| _13 | ไม่มี storage path ดิบใน response ของเจ้าของรูป | PASS | response ของอัปโหลดและ `me` (ผู้ดูแล + ผู้รับบริการ) มีแต่ signed URL |
| _13b | อายุ signed URL | PASS | รูปโปรไฟล์ขอ 3600 วินาที · เอกสาร KYC 900 วินาที (หมดอายุจริงหรือไม่ = ไม่ครอบ ดูด้านบน) |

**_12b / _12c สาเหตุ (ยืนยันจากโค้ด + เทส):** `ProfilePhotoService` เก็บรูปที่ path `<users.id>/profile-….jpg` ใน bucket `profile-photos` แล้วสร้างแถวใน `kyc_documents` · แต่ `CaregiverService.signDocuments` ถือว่าทุกแถวใน `kyc_documents` เป็นไฟล์ของ bucket `kyc-documents` ที่โฟลเดอร์แรกต้องเป็น **`supabase_uid`** — แถวรูปโปรไฟล์ใช้ `users.id` จึงไม่ผ่าน `assertPathBelongsToOwner` ซึ่งตั้งใจ throw ทั้งคำขอ · เส้นนี้ใช้ทั้ง `adminKycDetail` และ `kycStatus`
- prod (อ่านอย่างเดียว 2026-10-04): แถว `profile_photo` 2 แถว ของผู้ดูแล `verified` 2 คน ทั้งคู่ `pending` → **2 คนนี้เปิดหน้าสถานะ KYC ของตัวเองไม่ได้ และแอดมินเปิดรายละเอียด KYC ของ 2 คนนี้ไม่ได้อยู่ตอนนี้**
- ข้อเสนอ (ยังไม่แก้): ให้ `signDocuments` แยกแถว `profile_photo` ไป sign กับ bucket `profile-photos` และตรวจเจ้าของด้วย `users.id` — ด่านตรวจเจ้าของของเอกสาร KYC เดิมคงไว้ตามข้อ 3 ของ AC ใน PYG-547

## 4. KYC flow เดิม

| TC | เคส | ผล | หลักฐาน |
|---|---|---|---|
| _14 | ส่งบัตร → คิว → แอดมินเปิดดู → approve | PASS | `uploadKycDocument` → `submitKyc` = `pending` → อยู่ใน `adminKycList` → `adminKycDetail` เห็นบัตรเป็น signed URL → `approveKyc` = `verified` · `kyc_reviews` 1 แถว `approved`, `document_id` NULL |
| _15 | ส่งบัตร → reject → resubmit | PASS | `rejectKyc` = `rejected` · `kyc_reviews` `rejected` + เหตุผล, `document_id` NULL → `resubmitKyc` = `pending` |

KYC flow เดิมผ่าน **ตราบที่ผู้ดูแลยังไม่อัปโหลดรูปโปรไฟล์** — อัปโหลดแล้วแอดมินเปิดดูไม่ได้ (_12b กรณี KYC `pending`) จึง approve/reject แบบมองไม่เห็นเอกสาร

## 5. ข้อสังเกต (ไม่ได้ทำเป็นเคส FAIL — ต้องตัดสินใจ)
- **PYG-546 คาดว่า "อัปโหลดรูปใน step KYC"** แต่บัญชีผู้ดูแลที่ยังไม่เคย `submitKyc` ยังไม่มีแถว `caregivers` → อัปโหลดได้ 403 (_01c) ถ้าจะให้อัปโหลดในฟอร์ม KYC ต้องอัปหลัง submit หรือแก้ด่านนี้
- **Consent `sensitive_biometric`** (TODO ใน `profile-photo.service.ts` อ้าง PYG-503/473): ตาราง `user_consents` ขึ้นแล้ว แต่การอัปโหลดรูปใบหน้ายังไม่เช็ค consent
- ผู้ใช้ role อื่นที่อัปโหลดรูปแล้ว (prod 8 คน) ถ้าภายหลังถูกเปลี่ยนเป็นผู้ดูแล รูปนั้นจะแสดงโดยไม่ผ่านรีวิว — ไม่ได้ทดสอบ

## 6. วิธีรันซ้ำ

```bash
# ใช้ container เดียวกับ PYG-521 ได้ แยก database
docker exec pyg521-qa-db psql -U postgres -c "create database qa513"
DATABASE_URL=postgresql://x:x@127.0.0.1:1/x npx prisma migrate diff --from-empty \
  --to-schema-datamodel prisma/schema.prisma --script \
  | docker exec -i pyg521-qa-db psql -U postgres -d qa513 -q
# CHECK ที่ Prisma เขียนไม่ได้ (PYG-506)
docker exec pyg521-qa-db psql -U postgres -d qa513 -c "ALTER TABLE kyc_documents ADD CONSTRAINT kyc_documents_review_status_check CHECK (review_status IS NULL OR review_status IN ('pending','approved','rejected'))"
# seed service_price_catalog 5 ประเภท ราคา 300 (ผลค้นหาใช้คำนวณราคาเริ่มต้น)
PYG513_DATABASE_URL=postgresql://postgres:qa@127.0.0.1:5436/qa513 npm run test:e2e -- pyg513
# ดูข้อความที่ล้มจริงของ 7 เคส FAIL
PYG513_SHOW_BUGS=1 PYG513_DATABASE_URL=... npm run test:e2e -- pyg513
```

| ตรวจ | ผล |
|---|---|
| ต่อ Docker DB | 30 passed (รวม 7 เคส `it.failing`) · 3 todo |
| `PYG513_SHOW_BUGS=1` | 23 passed · 7 failed · 3 todo — ข้อความที่ล้มตรงกับตารางด้านบน |
| `npm run test:e2e` ไม่ตั้ง env | PYG-513 skip 33 · care-log 28 passed |
| `CI=1` ไม่ตั้ง env | ล้ม พร้อมข้อความ `PYG513_DATABASE_URL ไม่ได้ตั้งค่าใน CI` |
| `tsc -p tsconfig.json` | 21 error เท่า `dev` |
| `test/jest-e2e.json` | เหมือนของ #97 / #98 ทุกตัวอักษร (merge ลำดับไหนก็ไม่ชน) |
