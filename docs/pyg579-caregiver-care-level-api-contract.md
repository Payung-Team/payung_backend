# PYG-579 — API Contract: ระดับผู้ดูแล ต้น / กลาง / สูง · enum `CareLevel` · error code

> Story แม่: **PYG-557** (S02 · แอดมินกำหนดระดับผู้ดูแลตอนอนุมัติ KYC และผู้ดูแลเห็นระดับตัวเอง)
> ผู้ใช้ contract: **PYG-581** [BE] · **PYG-582** [FE] · **PYG-583** [QA] · อ้างอิงฝั่ง DB: **PYG-580** (PR #103 · deploy แล้ว 2026-10-07)
> สถานะ: **ร่างให้ BE/FE รีวิว** — เขียนบน branch `feature/pyg-579` วันที่ 2026-10-18
> BE ที่ทำตาม contract นี้อยู่บน branch `feature/pyg-581` (commit `2a5b7a7`) — ตรวจแล้วว่า
> operation ของ FE ทั้ง 102 ตัวที่ validate ผ่านบน `dev` ยัง validate ผ่านกับ `schema.gql` ใหม่ (ไม่มีตัวไหนพัง) ·
> error ตอบ HTTP 200 + `extensions.code` จริง (เทส e2e `test/pyg581-care-level-graphql.e2e-spec.ts`)

เอกสารนี้ส่งมอบ "ข้อตกลง" ไม่ใช่โค้ด — โค้ดของ BE ที่ทำตาม contract นี้อยู่ใน PYG-581
ทุกชื่อในเอกสาร **เทียบกับโค้ดจริงแล้ว** (`payung_backend` บน `dev` @ `3eeceb8` และ `payung_frontend`
บน `dev` @ `a550a06` ไฟล์ `src/graphql/queries.ts`, `src/pages/admin/KycReviewDetailPage.tsx`)

---

## 0. สรุปสั้นที่สุด (TL;DR)

| เรื่อง | ข้อตกลง |
|---|---|
| ค่าของระดับ | GraphQL: `BASIC` · `INTERMEDIATE` · `ADVANCED` — DB: `basic` · `intermediate` · `advanced` (เรียงต่ำ → สูง) |
| ชนิดใน GraphQL | ขาออก = enum `CareLevel` · ขาเข้า = `String` แล้ว BE ตรวจเอง (เหตุผลใน §2.2) |
| กำหนดระดับครั้งแรก | **ส่งมาพร้อมคำสั่งอนุมัติ**: `approveKyc(caregiverId, careLevel)` — ระดับ ประวัติ และ `kycStatus` อยู่ในทรานแซคชันเดียว (มติ 2026-10-18) |
| แก้ภายหลัง | `setCaregiverCareLevel(input)` — เฉพาะผู้ดูแลที่ `verified` · **บังคับเหตุผลเมื่อระดับเปลี่ยน** (มติ 2026-10-18) |
| ประวัติ | `caregiverCareLevelHistory(caregiverId)` — ใหม่ไปเก่า พร้อม `source` |
| ฝั่งอ่าน | ผู้ดูแล: `Caregiver.careLevel` · แอดมิน: `adminKycDetail.careLevelInfo` + `adminKycList.items[].careLevel / careLevelNeedsReview` |
| ฝั่ง Elder | **ยังไม่ส่ง** (REST `/public`, `CaregiverSummary`) จนกว่าทีมเคาะ |
| Error | **HTTP 200** + `errors[0].extensions.code` แบบเดียวกับ `PROFESSION_*`, `CONSENT_*` — ไม่ใช่ 422 (§5.1) |
| Migration | **ไม่ต้อง** — ใช้คอลัมน์และตารางที่ PYG-580 deploy แล้ว |
| ปล่อยของ | **FE (PYG-582) กับ BE (PYG-581) ต้องขึ้นพร้อมกัน** — หลัง BE ขึ้น หน้าอนุมัติ KYC เดิมจะได้ `CARE_LEVEL_REQUIRED` ทุกครั้ง (§7) |

---

## 1. มติที่ contract นี้ยึด และคำตอบของ "ประเด็นที่ต้องเคาะ" ใน PYG-557 / 579 / 581

| ประเด็น | คำตอบ | ที่มา |
|---|---|---|
| อนุมัติ KYC รับระดับอย่างไร: ส่งพร้อมคำสั่งอนุมัติ หรือกำหนดก่อนแล้วอนุมัติ | **ส่งพร้อมคำสั่งอนุมัติ** — ระดับ ประวัติ `kyc_status` อยู่ในทรานแซคชันเดียว ถ้าพังทั้งหมด rollback · ผู้ดูแลที่ยังไม่อนุมัติไม่มีระดับเลย (R7) | มติผู้รับการ์ด 2026-10-18 |
| การเปลี่ยนระดับต้องบังคับใส่เหตุผลไหม | **บังคับเมื่อระดับเปลี่ยนจริง** (`setCaregiverCareLevel`) · ตอนเลือกระดับพร้อมอนุมัติ KYC ไม่ต้องใส่ | มติผู้รับการ์ด 2026-10-18 |
| แก้ระดับของผู้ดูแลที่ KYC ยังไม่อนุมัติได้ไหม | **ไม่ได้** — `CARE_LEVEL_KYC_NOT_VERIFIED` · ระดับแรกเลือกตอนกดอนุมัติเท่านั้น | ตามมติข้อแรก + R7 |
| ประวัติเก็บที่ไหน | ตารางใหม่ `caregiver_care_level_logs` (PYG-580 สร้างแล้ว) ไม่ใช่ `caregiver_edit_logs` | PYG-580 deploy 2026-10-07 |
| `field_locks` เกี่ยวกับระดับไหม | **ไม่เกี่ยว** — ผู้ดูแลไม่มีทางแก้ระดับเองอยู่แล้ว (`updateCaregiverProfile` ไม่รับ field นี้) | โค้ด `UpdateCaregiverInput` |
| แจ้งเตือนผู้ดูแลเมื่อระดับเปลี่ยนไหม | **ยังไม่แจ้ง** — `NotificationType` เป็น enum ใน DB ต้อง migrate ก่อนเพิ่ม type ใหม่ (§9) | ข้อจำกัดเดียวกับ PYG-575 |
| E4 "บันทึกค่าเดิม = ไม่เปลี่ยน" ขัดกับ E3/AC6 "ต้น จนกว่าแอดมินทบทวน" | E4 ใช้กับค่า **ที่แอดมินกำหนดไว้แล้ว** เท่านั้น · ส่งค่าเดิมให้ผู้ดูแลที่ได้ค่าเริ่มต้นจาก migration = **แอดมินยืนยัน** → บันทึกผู้กำหนด + แถวประวัติ `old = new` (§4.2) | ข้อเสนอของ PYG-581 — **รอทีมยืนยัน** |
| HTTP 422 ตามการ์ด | ใช้ HTTP 200 + `extensions.code` ตามแนวของ repo (เหตุผล §5.1) | แนวเดียวกับ PYG-573 / PYG-601 |

---

## 2. ค่าของระดับ (R1)

| GraphQL (ส่ง/รับผ่าน API) | ค่าใน DB | ไทย | English |
|---|---|---|---|
| `BASIC` | `basic` | ต้น | Basic |
| `INTERMEDIATE` | `intermediate` | กลาง | Intermediate |
| `ADVANCED` | `advanced` | สูง | Advanced |

- เรียงจากต่ำไปสูง `BASIC < INTERMEDIATE < ADVANCED` — matching ของ S18 จะเทียบ "ระดับผู้ดูแล >= ระดับ booking" ด้วยลำดับนี้
- ค่าใน DB ตรงกับ CHECK `caregivers_care_level_check`, `caregiver_care_level_logs_*_level_check`,
  `bookings_required_level_check` (S16) และ `care_activities_care_level_check` (PYG-633) — **ชุดเดียวกันทั้งระบบ**
- ฝั่ง BE ประกาศ enum ที่เดียว: `src/common/care-level/care-level.ts` — ระดับ booking ของ S16 (PYG-569) ให้ import จากไฟล์นี้
- ข้อความแสดงผลเป็นหน้าที่ของ FE (แนะนำสร้าง `src/lib/careLevels.ts` แบบเดียวกับ `src/lib/professions.ts`) — BE ส่งเฉพาะค่า

```graphql
"""Caregiver / job level, lowest to highest: BASIC (ต้น) < INTERMEDIATE (กลาง) < ADVANCED (สูง)"""
enum CareLevel {
  ADVANCED
  BASIC
  INTERMEDIATE
}
```

### 2.1 ขาออก — enum `CareLevel`

ทุก field ที่ BE ส่งระดับออกไปใช้ enum `CareLevel` (FE ได้ `"BASIC"` ไม่ใช่ `"basic"`)

### 2.2 ขาเข้า — `String` ที่ BE ตรวจเอง

`approveKyc(careLevel:)` และ `SetCaregiverCareLevelInput.level` เป็น `String` ไม่ใช่ enum โดยตั้งใจ:

- ถ้าเป็น enum, GraphQL ปฏิเสธค่าผิดเองด้วย `GRAPHQL_VALIDATION_FAILED` → FE ไม่มีวันได้ `CARE_LEVEL_INVALID` ตามการ์ด
- ถ้าใส่ `@IsIn` ใน DTO, ValidationPipe ตอบ `BAD_REQUEST` ก่อนถึง service (บทเรียน PYG-415)
- ค่าที่รับ: `"BASIC"` · `"INTERMEDIATE"` · `"ADVANCED"` **ตรงตัว** — ไม่ trim ไม่แปลงตัวพิมพ์ (`"basic"` = `CARE_LEVEL_INVALID`)
- แนวเดียวกับ `KycInput.profession` ของ PYG-573 §3.2

---

## 3. Field ฝั่งอ่าน — เพิ่มอย่างเดียว ไม่ลบ/ไม่เปลี่ยนชนิดของ field เดิม (client เก่าไม่พัง)

### 3.1 ผู้ดูแลเห็นระดับของตัวเอง (S02-AC5)

```graphql
type Caregiver {
  # ...field เดิมทั้งหมด...
  """Caregiver level set by an admin: BASIC | INTERMEDIATE | ADVANCED (null = not set yet)"""
  careLevel: CareLevel
}
```

- อ่านผ่าน `myCaregiverProfile` (role 2) — ผู้ดูแลเห็นได้เฉพาะของตัวเอง เพราะ query นี้หาแถวจากผู้ใช้ที่ล็อกอิน ไม่รับ id
- มีใน `kycStatus.caregiver`, `me.caregiver`, ผลของ `approveKyc` / `rejectKyc`, `adminKycDetail.caregiver`, `adminUserDetail.caregiver` ด้วย (type เดียวกัน)
- `null` = ยังไม่มีระดับ → FE แสดง "ยังไม่ได้กำหนดระดับ" ไม่ใช่ช่องว่างหรือ error (E5)
- **ผู้ดูแลไม่เห็นว่าใครกำหนดและเมื่อไร** — ข้อมูลนั้นเป็นของแอดมิน (§3.2)

ตัวอย่าง — `GET_CAREGIVER_PROFILE` ของ FE เพิ่ม `careLevel` บรรทัดเดียว:

```graphql
query GetCaregiverProfile {
  myCaregiverProfile {
    id
    kycStatus
    careLevel
  }
}
```

```json
{ "data": { "myCaregiverProfile": { "id": "3f1c2b4a-…", "kycStatus": "verified", "careLevel": "INTERMEDIATE" } } }
```

### 3.2 แอดมิน — หน้า KYC review (S02-AC3 · E3)

```graphql
type AdminKycDetailPayload {
  # ...field เดิมทั้งหมด...
  """Current care level with who set it and when (level is null when not set yet)"""
  careLevelInfo: CaregiverCareLevelInfo!
}

type CaregiverCareLevelInfo {
  caregiverId: ID!
  level: CareLevel          # null = ยังไม่มีระดับ
  setBy: ID                 # users.id ของแอดมิน — null = ค่าเริ่มต้นจาก migration หรือยังไม่มีระดับ
  setByName: String         # users.display_name ของแอดมิน
  setAt: DateTime
  needsReview: Boolean!     # true = level ไม่ใช่ null และ setBy เป็น null → ค่าเริ่มต้นจาก migration ที่ยังไม่ทบทวน
}

type CaregiverKycSummary {   # แต่ละแถวของ adminKycList
  # ...field เดิมทั้งหมด...
  careLevel: CareLevel
  careLevelNeedsReview: Boolean!
}
```

- `setBy` เป็น `null` สำหรับผู้ดูแลเดิม 50 คนที่ PYG-580 backfill เป็น `basic` — **ส่ง null ตรง ๆ ไม่แทนด้วยผู้ใช้สมมติ**
- `needsReview` / `careLevelNeedsReview` ให้ FE แยก "ต้น ที่ระบบตั้งให้" ออกจาก "ต้น ที่แอดมินเลือกเอง" ได้ (E3, Design PYG-578)
- ผู้ดูแลที่อนุมัติ **หลัง** PYG-580 (2026-10-07) แต่ **ก่อน** PYG-581 ขึ้น จะเป็น `verified` + `level: null` + `needsReview: false`
  → แอดมินกำหนดให้ได้ทาง `setCaregiverCareLevel` (§4.2)

ตัวอย่าง:

```graphql
query AdminKycDetail($caregiverId: ID!) {
  adminKycDetail(caregiverId: $caregiverId) {
    caregiver { id kycStatus careLevel }
    careLevelInfo { level setBy setByName setAt needsReview }
  }
}
```

```json
{
  "data": {
    "adminKycDetail": {
      "caregiver": { "id": "3f1c2b4a-…", "kycStatus": "verified", "careLevel": "BASIC" },
      "careLevelInfo": { "level": "BASIC", "setBy": null, "setByName": null, "setAt": "2026-10-07T03:57:48.000Z", "needsReview": true }
    }
  }
}
```

### 3.3 ฝั่ง Elder — ยังไม่เพิ่ม

`caregiver-public` (REST `/public`), `CaregiverSummary` ของหน้าค้นหา และ field อื่นที่ Elder เห็น **ไม่มี** `careLevel`
จนกว่าทีมเคาะว่า Elder ควรเห็นระดับไหม และเห็นที่หน้าใด (story "ไม่อยู่ในขอบเขต")

---

## 4. Operation ฝั่งเขียน (แอดมิน role 3 / 4 เท่านั้น)

### 4.1 `approveKyc` — เลือกระดับพร้อมอนุมัติ (S02-AC1, AC2 · E1 · E9)

```graphql
type Mutation {
  approveKyc(
    caregiverId: ID!
    """BASIC | INTERMEDIATE | ADVANCED — the caregiver level chosen at approval."""
    careLevel: String          # ← เพิ่มใหม่ · ไม่บังคับใน schema แต่บังคับในกติกา (อ่านต่อ)
  ): Caregiver!
}
```

กติกา (ทำตามลำดับ):

| # | เงื่อนไข | ผล |
|---|---|---|
| 1 | `careLevel` เป็นค่านอก 3 ค่า | `CARE_LEVEL_INVALID` — ก่อนแตะ DB (E9) |
| 2 | ไม่พบผู้ดูแล | `INTERNAL_SERVER_ERROR` + `status: 404` (พฤติกรรมเดิม) |
| 3 | `kycStatus` ไม่ใช่ `pending` | `BAD_REQUEST` (none) / `INTERNAL_SERVER_ERROR` + `status: 409` (verified / rejected) — พฤติกรรมเดิม |
| 4 | ไม่ส่ง `careLevel` (หรือส่ง `null` / `""`) **และ** ผู้ดูแลยังไม่มีระดับ | `CARE_LEVEL_REQUIRED` — `kycStatus` ไม่เปลี่ยน ไม่มีอะไรถูกเขียน (E1) |
| 5 | ไม่ส่ง `careLevel` แต่ผู้ดูแลมีระดับอยู่แล้ว | อนุมัติได้ คงระดับเดิม ไม่เพิ่มประวัติ (กันไว้สำหรับการตรวจซ้ำ E8 — ทางปัจจุบันยังไม่มีเคสนี้) |
| 6 | ส่ง `careLevel` = ค่าเดิมที่มีอยู่แล้ว | อนุมัติได้ ไม่เพิ่มประวัติ (E4) |
| 7 | ส่ง `careLevel` ถูกต้อง | ในทรานแซคชันเดียว: `care_level` + `care_level_set_by` (แอดมินที่ล็อกอิน) + `care_level_set_at` + แถวประวัติ (`source: KYC_APPROVAL`) + `kycStatus = verified` + `kyc_reviews` |

- **ทำไม `careLevel` ไม่บังคับใน schema:** ถ้าเป็น `String!` หน้าอนุมัติของ FE เวอร์ชันปัจจุบันจะพังด้วย error ของ schema
  ที่ FE ไม่รู้จัก — แบบนี้ FE เวอร์ชันเก่าได้ `CARE_LEVEL_REQUIRED` พร้อมข้อความภาษาไทยที่แสดงได้เลย
- ผู้กำหนดอ่านจากผู้ใช้ที่ล็อกอินเสมอ — **ไม่รับจาก input**
- `rejectKyc` **ไม่เปลี่ยน** — ปฏิเสธได้โดยไม่ต้องมีระดับ (E2)

ตัวอย่าง request (สิ่งที่ FE PYG-582 ต้องเปลี่ยน `APPROVE_KYC` เป็น):

```graphql
mutation ApproveKyc($caregiverId: ID!, $careLevel: String) {
  approveKyc(caregiverId: $caregiverId, careLevel: $careLevel) {
    id
    kycStatus
    kycVerifiedAt
    updatedAt
    careLevel
  }
}
```

```json
{ "caregiverId": "3f1c2b4a-5d6e-4f70-8a91-b2c3d4e5f607", "careLevel": "INTERMEDIATE" }
```

response สำเร็จ:

```json
{
  "data": {
    "approveKyc": {
      "id": "3f1c2b4a-5d6e-4f70-8a91-b2c3d4e5f607",
      "kycStatus": "verified",
      "kycVerifiedAt": "2026-10-18T03:00:00.000Z",
      "updatedAt": "2026-10-18T03:00:00.000Z",
      "careLevel": "INTERMEDIATE"
    }
  }
}
```

response เมื่อไม่ได้เลือกระดับ (E1):

```json
{
  "errors": [{
    "message": "กรุณาเลือกระดับผู้ดูแล (ต้น / กลาง / สูง) ก่อนอนุมัติ",
    "path": ["approveKyc"],
    "extensions": { "code": "CARE_LEVEL_REQUIRED", "allowed": ["BASIC", "INTERMEDIATE", "ADVANCED"] }
  }],
  "data": null
}
```

### 4.2 `setCaregiverCareLevel` — แก้ระดับภายหลัง (S02-AC4 · E4 · E6)

```graphql
input SetCaregiverCareLevelInput {
  caregiverId: ID!          # UUID v4 (DTO ตรวจ — ผิดรูป = BAD_REQUEST)
  level: String             # BASIC | INTERMEDIATE | ADVANCED (service ตรวจ)
  reason: String            # บังคับเมื่อระดับเปลี่ยนจริง · ไม่เกิน 500 ตัวอักษร
}

type SetCaregiverCareLevelPayload {
  changed: Boolean!                       # false = ค่าเดิมที่แอดมินกำหนดไว้แล้ว ไม่มีอะไรเปลี่ยน
  careLevel: CaregiverCareLevelInfo!      # ค่าหลังบันทึก (type เดียวกับ §3.2)
}

type Mutation {
  setCaregiverCareLevel(input: SetCaregiverCareLevelInput!): SetCaregiverCareLevelPayload!
}
```

กติกา (ทำตามลำดับ):

| # | เงื่อนไข | ผล |
|---|---|---|
| 1 | `level` ไม่ส่ง / ว่าง | `CARE_LEVEL_REQUIRED` — ก่อนแตะ DB |
| 2 | `level` นอก 3 ค่า | `CARE_LEVEL_INVALID` — ก่อนแตะ DB (E9) |
| 3 | ไม่พบผู้ดูแล | `INTERNAL_SERVER_ERROR` + `status: 404` |
| 4 | `kycStatus` ไม่ใช่ `verified` | `CARE_LEVEL_KYC_NOT_VERIFIED` + `kycStatus` — ระดับแรกเลือกตอนอนุมัติ (R7) |
| 5 | `level` = ค่าเดิม **และ** มีแอดมินเป็นผู้กำหนดอยู่แล้ว | สำเร็จ `changed: false` — ไม่เพิ่มประวัติ ไม่เปลี่ยนผู้กำหนด/เวลา ไม่ต้องมีเหตุผล (E4) |
| 6 | `reason` ว่าง / มีแต่ช่องว่าง | `CARE_LEVEL_REASON_REQUIRED` — ไม่มีอะไรถูกเขียน |
| 7 | ผ่านทุกข้อ | `changed: true` — เขียนระดับ + ผู้กำหนด + เวลา + แถวประวัติ (`source: ADMIN_UPDATE`, `reason` ที่ trim แล้ว) ในทรานแซคชันเดียว |

- **ยืนยันค่าเริ่มต้นจาก migration (ข้อเสนอ — รอทีมยืนยัน):** ผู้ดูแลที่ `needsReview: true` (ต้น จาก migration)
  ถ้าแอดมินส่ง `BASIC` เท่าเดิม ข้อ 5 **ไม่** ใช้ เพราะยังไม่เคยมีแอดมินกำหนด → ไปข้อ 6–7: ต้องมีเหตุผล,
  บันทึกผู้กำหนด/เวลา และเพิ่มแถวประวัติ `oldLevel = newLevel = BASIC` → `needsReview` กลายเป็น `false`
  ถ้าตีความ E4 ตรงตัว ผู้ดูแลกลุ่มนี้จะติด "ยังไม่ทบทวน" ตลอดไป เว้นแต่แอดมินเปลี่ยนเป็นระดับอื่น ซึ่งขัดกับ AC6
- **แอดมินสองคนแก้ใกล้กัน (E6):** BE ล็อกแถวผู้ดูแล (`SELECT … FOR UPDATE`) ก่อนอ่านค่าเดิม → คนที่สองรอจนคนแรกเสร็จ
  ค่าล่าสุดชนะ ประวัติมีครบทั้งสองแถว และ `oldLevel` ของแถวที่สองคือค่าที่คนแรกเพิ่งตั้ง
  เวลาใช้ `clock_timestamp()` หลังได้ล็อก ประวัติจึงเรียงถูกเสมอ
- ผู้ดูแลที่ `verified` แต่ `level: null` (อนุมัติช่วงก่อน PYG-581 ขึ้น) ใช้ mutation นี้กำหนดระดับแรกได้ (`oldLevel: null`) — ต้องมีเหตุผล

ตัวอย่าง:

```graphql
mutation SetCaregiverCareLevel($input: SetCaregiverCareLevelInput!) {
  setCaregiverCareLevel(input: $input) {
    changed
    careLevel { caregiverId level setBy setByName setAt needsReview }
  }
}
```

```json
{ "input": { "caregiverId": "3f1c2b4a-5d6e-4f70-8a91-b2c3d4e5f607", "level": "ADVANCED", "reason": "มีใบอนุญาตประกอบวิชาชีพการพยาบาลแล้ว" } }
```

```json
{
  "data": {
    "setCaregiverCareLevel": {
      "changed": true,
      "careLevel": {
        "caregiverId": "3f1c2b4a-5d6e-4f70-8a91-b2c3d4e5f607",
        "level": "ADVANCED",
        "setBy": "user-admin-1",
        "setByName": "แอดมิน ทดสอบ",
        "setAt": "2026-10-18T03:00:00.000Z",
        "needsReview": false
      }
    }
  }
}
```

### 4.3 `caregiverCareLevelHistory` — ประวัติ (S02-AC4)

```graphql
enum CareLevelChangeSource {
  ADMIN_UPDATE        # แอดมินแก้ผ่าน setCaregiverCareLevel (มีเหตุผลเสมอ)
  KYC_APPROVAL        # แอดมินเลือกตอนอนุมัติ KYC
  MIGRATION_DEFAULT   # ระบบตั้งให้ตอน migration PYG-580 — ยังไม่ผ่านการทบทวน
}

type CareLevelChange {
  id: ID!
  oldLevel: CareLevel        # null = กำหนดครั้งแรก
  newLevel: CareLevel!       # เท่ากับ oldLevel ได้ = แอดมินยืนยันค่าเริ่มต้น (§4.2)
  changedBy: ID              # null = ระบบ (migration)
  changedByName: String
  reason: String             # ข้อความของแอดมิน · null สำหรับแถว KYC_APPROVAL / MIGRATION_DEFAULT
  source: CareLevelChangeSource!
  createdAt: DateTime!
}

type Query {
  caregiverCareLevelHistory(caregiverId: ID!): [CareLevelChange!]!
}
```

- เรียงใหม่ไปเก่า (`created_at DESC` — มี index `caregiver_care_level_logs_caregiver_idx` รองรับ) · คืนทุกแถว ไม่แบ่งหน้า (ผู้ดูแลหนึ่งคนมีไม่กี่แถว)
- ผู้ดูแลที่ยังไม่มีประวัติ → `[]` · ไม่พบผู้ดูแล → `INTERNAL_SERVER_ERROR` + `status: 404`
- `source` คำนวณให้แล้ว — FE ไม่ต้องรู้ค่าภายในอย่าง `migration_default`

ตัวอย่าง response:

```json
{
  "data": {
    "caregiverCareLevelHistory": [
      { "id": "…", "oldLevel": "BASIC", "newLevel": "ADVANCED", "changedBy": "user-admin-1", "changedByName": "แอดมิน ทดสอบ",
        "reason": "มีใบอนุญาตประกอบวิชาชีพการพยาบาลแล้ว", "source": "ADMIN_UPDATE", "createdAt": "2026-10-18T03:00:00.000Z" },
      { "id": "…", "oldLevel": null, "newLevel": "BASIC", "changedBy": null, "changedByName": null,
        "reason": null, "source": "MIGRATION_DEFAULT", "createdAt": "2026-10-07T03:57:48.000Z" }
    ]
  }
}
```

### 4.4 สิทธิ์

| Operation | แอดมิน (3) / ซูเปอร์แอดมิน (4) | ผู้ดูแล (2) | ผู้สูงอายุ (1) |
|---|---|---|---|
| `approveKyc` (+ `careLevel`) | ✅ | `FORBIDDEN` | `FORBIDDEN` |
| `setCaregiverCareLevel` | ✅ | `FORBIDDEN` | `FORBIDDEN` |
| `caregiverCareLevelHistory` | ✅ | `FORBIDDEN` | `FORBIDDEN` |
| `myCaregiverProfile.careLevel` | `FORBIDDEN` (ใช้ `adminKycDetail` แทน) | ✅ ของตัวเองเท่านั้น | `FORBIDDEN` |

`FORBIDDEN` มาจาก `RolesGuard` เดิม (ไม่ใช่ code ใหม่) · ไม่มี token = `UNAUTHENTICATED`

---

## 5. Error contract

### 5.1 รูปแบบ — HTTP 200 + `extensions.code` (★ ไม่ใช่ 422)

การ์ดเสนอ "ตอบ 422 ตามแนวที่ repo ใช้" แต่ฝั่ง GraphQL ของ repo นี้ไม่ได้ส่ง HTTP status ของ business error ออกไป:
Apollo ตอบ HTTP 200 แล้วใส่ error ใน `errors[]` และ FE อ่าน `extensions.code` (`extractGraphQLErrorCode`)
ถ้า BE โยน `UnprocessableEntityException` (422) `@nestjs/apollo` จะแปลงเป็น code ทั่วไป `BAD_USER_INPUT`
→ FE แยกไม่ออกว่า "ยังไม่ได้เลือกระดับ" หรือ "ส่งค่าผิด" — แนวเดียวกับ `ProfessionError` (PYG-573), `ConsentError`, `FieldLockedError`

```jsonc
{ "errors": [ { "message": "<ข้อความภาษาไทย แสดงให้ผู้ใช้ได้>", "extensions": { "code": "<CODE>", "...": "ข้อมูลเสริม" } } ], "data": null }
```

### 5.2 รายการ code (ห้ามเปลี่ยนสตริงโดยไม่บอกทีม FE)

| code | เมื่อไร | extensions เสริม | ข้อความ (message) |
|---|---|---|---|
| `CARE_LEVEL_REQUIRED` | อนุมัติโดยไม่มีระดับ (E1) · `setCaregiverCareLevel` ไม่ส่ง `level` | `allowed: string[]` | กรุณาเลือกระดับผู้ดูแล (ต้น / กลาง / สูง) ก่อนอนุมัติ · กรุณาเลือกระดับผู้ดูแล |
| `CARE_LEVEL_INVALID` | ค่านอก 3 ค่า (E9) | `allowed: string[]`, `received: string` | ระดับผู้ดูแลไม่ถูกต้อง |
| `CARE_LEVEL_REASON_REQUIRED` | เปลี่ยนระดับโดยไม่มีเหตุผล | — | กรุณาระบุเหตุผลของการเปลี่ยนระดับ |
| `CARE_LEVEL_KYC_NOT_VERIFIED` | `setCaregiverCareLevel` กับผู้ดูแลที่ไม่ใช่ `verified` | `kycStatus: string` | แก้ระดับได้เฉพาะผู้ดูแลที่อนุมัติ KYC แล้ว — ผู้ดูแลที่รอตรวจให้เลือกระดับตอนกดอนุมัติ |

error อื่นที่อาจเจอ (ไม่ใช่ของ contract นี้ — พฤติกรรมเดิมของ repo):

- `FORBIDDEN` (role ไม่ตรง) · `UNAUTHENTICATED` (ไม่มี/ผิด token)
- `BAD_REQUEST` — DTO ไม่ผ่าน: `caregiverId` ไม่ใช่ UUID, `reason` ยาวเกิน 500 ตัวอักษร
- `INTERNAL_SERVER_ERROR` + `status: 404` — ไม่พบผู้ดูแล (`NotFoundException` ซึ่ง `@nestjs/apollo` ไม่มี code เฉพาะให้)
- `INTERNAL_SERVER_ERROR` + `status: 409` — อนุมัติซ้ำ / อนุมัติคนที่ถูกปฏิเสธแล้ว (`ConflictException` เดิม)

---

## 6. ที่เก็บข้อมูล (PYG-580 — deploy แล้ว ไม่ต้อง migrate)

| คอลัมน์ / ตาราง | ใช้ทำอะไร |
|---|---|
| `caregivers.care_level` (text, NULL ได้, CHECK 3 ค่า) | ระดับปัจจุบัน |
| `caregivers.care_level_set_by` (text → `users.id`) | แอดมินที่กำหนดล่าสุด · NULL = ค่าเริ่มต้นจาก migration |
| `caregivers.care_level_set_at` (timestamptz) | เวลาที่กำหนดล่าสุด |
| `caregiver_care_level_logs` | หนึ่งแถว = หนึ่งครั้งที่ระดับถูกกำหนด/เปลี่ยน (`old_level`, `new_level`, `changed_by`, `reason`, `created_at`) |

ค่าพิเศษในคอลัมน์ `caregiver_care_level_logs.reason` ที่ระบบเขียนเอง (FE ไม่เห็นค่าเหล่านี้ — ดู `source` แทน):

| ค่า | เขียนโดย | `source` |
|---|---|---|
| `migration_default` | backfill ของ PYG-580 (50 แถว · `changed_by` = NULL) | `MIGRATION_DEFAULT` |
| `kyc_approval` | `approveKyc` ที่ส่ง `careLevel` | `KYC_APPROVAL` |
| ข้อความอื่น | `setCaregiverCareLevel` (เหตุผลของแอดมิน) | `ADMIN_UPDATE` |

การเขียนระดับ (`caregivers`) กับแถวประวัติ อยู่ในทรานแซคชันเดียวกันเสมอ — สำเร็จหรือล้มพร้อมกัน

---

## 7. สิ่งที่ FE (PYG-582) ต้องทำ และลำดับการปล่อย

**ลำดับการปล่อย: BE กับ FE ต้องขึ้นพร้อมกัน** — หลัง BE ขึ้น `APPROVE_KYC` เวอร์ชันปัจจุบันของ FE (ไม่ส่ง `careLevel`)
จะได้ `CARE_LEVEL_REQUIRED` ทุกครั้งกับผู้ดูแลใหม่ = แอดมินอนุมัติ KYC ไม่ได้จนกว่า FE ใหม่จะขึ้น (ตั้งใจตาม R4)
ถ้าต้องขึ้นห่างกัน ให้ BE ขึ้นตอนที่ไม่มีคิว KYC รอ หรือแจ้งแอดมินล่วงหน้า

| จุดใน FE | ต้องทำ |
|---|---|
| `src/graphql/queries.ts` → `APPROVE_KYC` | เพิ่ม `$careLevel: String` และ `careLevel: $careLevel` (§4.1) |
| `src/pages/admin/KycReviewDetailPage.tsx` | ตัวเลือกระดับ 3 ค่าใกล้ปุ่มอนุมัติ · กดอนุมัติโดยไม่เลือก = ข้อความ error ที่ตัวเลือก (E1) · ปฏิเสธไม่ต้องเลือก (E2) · ส่งระดับไปกับ `approveKyc` |
| `ADMIN_KYC_DETAIL` | เพิ่ม `careLevelInfo { level setBy setByName setAt needsReview }` (§3.2) |
| `ADMIN_KYC_LIST` | เพิ่ม `careLevel careLevelNeedsReview` ในแต่ละแถว ถ้าจะแปะป้าย "รอทบทวน" ในตาราง |
| หน้าแก้ระดับภายหลัง (Design PYG-578) | `setCaregiverCareLevel` + ช่องเหตุผล (บังคับ) + ขั้นยืนยัน · `changed: false` = แจ้งว่า "ระดับเดิม ไม่มีการเปลี่ยนแปลง" |
| ส่วนประวัติ | `caregiverCareLevelHistory` · แสดง `source` เป็นข้อความ (เช่น MIGRATION_DEFAULT = "ค่าเริ่มต้นจากระบบ") |
| `GET_CAREGIVER_PROFILE` + หน้าโปรไฟล์ผู้ดูแล | เพิ่ม `careLevel` · ป้ายระดับ (แยกจาก `ProfessionBadge` ได้ ไม่พึ่งสีอย่างเดียว) · `null` = "ยังไม่ได้กำหนดระดับ" (E5) |
| `src/lib/` | ข้อความ ต้น/กลาง/สูง ไว้ที่เดียว (แนะนำ `careLevels.ts`) — ใช้ร่วมกับระดับ booking ของ S16 |
| การจัดการ error | อ่าน `extensions.code` ตาม §5.2 — ข้อความใน `message` เป็นภาษาไทยแสดงได้เลย |

---

## 8. การทดสอบที่ทำแล้ว (บน `feature/pyg-581`)

| ชุด | ผล |
|---|---|
| `npx tsc --noEmit` | 0 error (เท่ากับ baseline บน `dev` @ `3eeceb8`) |
| `npx jest` | 95/95 suites · 1774/1774 tests (baseline 93 / 1708 + เทสใหม่ 2 ไฟล์ 66 เคส) |
| `test:e2e` | 2 passed + 1 skipped (`pyg544-*` ต้องมี DB — เท่ากับ baseline) · ไฟล์ใหม่ `pyg581-*` 15 เคสผ่าน |
| FE ops กับ `schema.gql` ใหม่ | 102/102 ตัวที่ผ่านบน `dev` ยังผ่าน — ไม่มีตัวไหนพัง |
| `schema.gql` | สร้างใหม่แบบ offline จากโค้ดจริง ตรงทุกไบต์ยกเว้นส่วนที่เพิ่ม |

**ยังไม่ได้ทดสอบ:** `SELECT … FOR UPDATE` + `clock_timestamp()` กับ Postgres จริง (เทสใช้ DB ปลอมในหน่วยความจำ ทดสอบ E6 แบบ "ต่อกัน")
และ flow เต็มผ่านหน้าจอ (รอ FE PYG-582) — ฝาก QA PYG-583

---

## 9. ประเด็นที่ยังเปิดอยู่ (ไม่บล็อก S02 แต่ต้องมีคนตัดสิน)

1. **เกณฑ์ของแต่ละระดับ** (REQ-A04) — แอดมินใช้อะไรตัดสินว่าใครเป็น ต้น/กลาง/สูง · ต้องถามอาจารย์ / infographic ล่าสุด
2. **ยืนยันการตีความ E4 vs E3/AC6** (§4.2) — ส่งค่าเดิมให้ผู้ดูแลที่ได้ค่าเริ่มต้น = แอดมินยืนยัน (BE ทำแบบนี้อยู่)
3. **แผนทบทวนผู้ดูแลเดิม 50 คนก่อนเปิด S18** — ถ้าไม่ทบทวน ทุกคนรับได้แค่ booking ระดับต้น · `adminKycList` ยังไม่มีตัวกรอง "รอทบทวน" (มีแค่ field) — เพิ่มได้ถ้าต้องการ
4. **Elder เห็นระดับไหม** และเห็นที่หน้าใด (§3.3)
5. **แจ้งเตือนผู้ดูแลเมื่อระดับเปลี่ยน** — ต้อง migrate enum `NotificationType` ก่อน (ส่งให้ Sammy)
6. **E7** ลดระดับผู้ดูแลที่มี booking ค้างที่ต้องการระดับสูงกว่า — story นี้ไม่แตะ booking ต้องตกลงกับ S18
7. **E8** ผู้ดูแลถูกส่งกลับตรวจ KYC ใหม่ — BE ตอนนี้ "คงระดับเดิม ถ้าแอดมินไม่เลือกใหม่" (§4.1 ข้อ 5) · ปัจจุบันยังไม่มีทางที่ `verified` กลับเป็น `pending`
8. **S16 (PYG-569) ใช้ enum `CareLevel` ชุดเดียวกัน** — ประกาศไว้ที่ `src/common/care-level/care-level.ts` แล้ว รอเจ้าของ S16 รับทราบ
9. (นอกขอบเขต เจอระหว่างทำ) `rejectKyc` ยังไม่ล็อกแถวก่อนเขียน — ถ้าแอดมินสองคนกด "อนุมัติ" กับ "ปฏิเสธ" พร้อมกันพอดี คนหลังเขียนทับได้ · `approveKyc` ล็อกแล้วใน PYG-581
