# PYG-573 — API Contract: field `profession` · error code · คำขอเปลี่ยนวิชาชีพหลัง KYC อนุมัติ

> Story แม่: **PYG-556** (S01 · ผู้ดูแลระบุวิชาชีพใน KYC และ Elder เห็นวิชาชีพในหน้า List/Profile)
> ผู้ใช้ contract: **PYG-575** [BE] · **PYG-576** [FE] · **PYG-577** [QA] · อ้างอิงฝั่ง DB: **PYG-574** (PR #102 · deploy แล้ว 2026-10-07)
> สถานะ: **ร่างให้ BE/FE รีวิว** — เขียนบน branch `feature/pyg-573` วันที่ 2026-10-17
> BE ที่ทำตาม contract นี้อยู่บน branch `feature/pyg-575` — ตรวจแล้วว่า operation ของ FE ทั้ง 9 ตัวที่เกี่ยวข้อง
> (`professionChange.ts` 3 ตัว + query ใน `queries.ts` ที่เปิด `PROFESSION_FIELD` อีก 6 ตัว) validate ผ่านกับ `schema.gql`
> ที่ BE สร้าง · error ตอบ HTTP 200 + `extensions.code` จริง (เทส e2e `test/pyg575-*`) · SQL ของคำขอเปลี่ยนวิชาชีพ
> รันกับ DB จริงแบบ read-only ผ่าน (2026-10-17)

เอกสารนี้ส่งมอบ "ข้อตกลง" ไม่ใช่โค้ด — โค้ดของ BE ที่ทำตาม contract นี้อยู่ใน PYG-575
ทุกชื่อในเอกสาร **เทียบกับโค้ดจริงแล้ว** (`payung_backend` บน `dev` @ `3eeceb8` และ `payung_frontend`
บน `dev` @ `d1a42a2` ไฟล์ `src/graphql/professionChange.ts`, `src/graphql/queries.ts`, `src/lib/professions.ts`)

---

## 0. สรุปสั้นที่สุด (TL;DR)

| เรื่อง | ข้อตกลง |
|---|---|
| ค่าของวิชาชีพ | `general_caregiver` · `nurse` · `physiotherapist` — **ตัวพิมพ์เล็ก** ตรงกับ CHECK ใน DB และ `PROFESSION_CODES` ของ FE |
| ชนิดใน GraphQL | ขาออก = enum `CaregiverProfession` · ขาเข้า = `String` แล้ว BE ตรวจเอง (เหตุผลใน §3.2) |
| ฝั่งอ่าน | `Caregiver.profession` (โปรไฟล์ตัวเอง, `kycStatus.caregiver`, `adminKycDetail.caregiver`) · `CaregiverSummary.profession` (หน้า List) · REST `/public` key `profession` (หน้า Profile) |
| ฝั่งเขียน (KYC) | `KycInput.profession` **บังคับ** — ไม่ส่ง = `PROFESSION_REQUIRED` · ค่านอกรายการ = `PROFESSION_INVALID` |
| เปลี่ยนหลังอนุมัติ (AC6) | **คำขอแยก** ไม่ใช่ส่ง KYC ใหม่ทั้งชุด: `requestProfessionChange` → แอดมิน `approve…` / `reject…` |
| ชื่อ operation | **ตรงกับที่ FE เขียนไว้แล้วใน `graphql/professionChange.ts` ทุกตัว** — FE ไม่ต้องแก้ query |
| ที่เก็บคำขอ | แถวใน `caregiver_edit_logs` (มีอยู่แล้ว) — **ไม่ต้อง migrate** (มติ 2026-10-17 · §6) |
| Error | **HTTP 200** + `errors[0].extensions.code` แบบเดียวกับ `CONSENT_*`, `FIELD_LOCKED` — ไม่ใช่ 422 (§5.1) |

---

## 1. มติที่ contract นี้ยึด และคำตอบของ "ประเด็นที่ต้องเคาะ" ใน PYG-556

| ประเด็น (story) | คำตอบ | ที่มา |
|---|---|---|
| AC6 ใช้กลไกใด: ส่ง KYC ใหม่ทั้งชุด หรือคำขอแยก | **คำขอแยก** — ส่ง KYC ใหม่ทำให้ `kycStatus` กลับเป็น `pending` ซึ่งปิดการค้นหาและรับงานระหว่างรอ ขัดกับกติกา "ระหว่างรอ Elder เห็นค่าเดิม" ใน PYG-575 และ FE สร้างหน้าจอคำขอแยกไว้แล้ว | PYG-575, FE `ProfessionChangeCard.tsx` |
| เก็บคำขอไว้ที่ไหน | แถวใน `caregiver_edit_logs` ไม่สร้างตารางใหม่ → **ไม่มี migration** | มติผู้รับการ์ด 2026-10-17 |
| ระหว่างรอแอดมินตรวจ ผู้ดูแลรับงานด้วยวิชาชีพเดิมได้ไหม | **ได้** — `caregivers.profession` ไม่เปลี่ยนจนกว่าแอดมินอนุมัติ ทุกหน้าที่อ่านค่านี้ (List, Profile, matching ในอนาคต) เห็นค่าเดิม | PYG-575 ("ค่าที่ฝั่ง Elder เห็นคือค่าเดิม") |
| เพิ่ม "ผู้ช่วยพยาบาล" เป็นค่าที่ 4 ไหม | **ยังไม่เพิ่ม** — DB มี CHECK 3 ค่า ถ้าเคาะเพิ่มต้องทำตามลำดับใน §8 | PYG-574 คอมเมนต์ 2026-10-07 |
| `profession` ล็อกด้วย `field_locks` ได้ไหม | **ไม่ต้องล็อก** — `updateCaregiverProfile` ไม่รับ `profession` อยู่แล้ว ทางเดียวที่เปลี่ยนได้หลังอนุมัติคือคำขอที่แอดมินตรวจ ซึ่งเข้มกว่าการล็อก | โค้ด `UpdateCaregiverInput` |
| DEFAULT `'general_caregiver'` ของคอลัมน์ — ถอดไหม | **คงไว้** — API บังคับค่าแล้ว แต่ยังมีทาง insert อื่นที่ไม่ผ่าน KYC (`CaregiverService.create`) ถอดแล้วจะพัง | PYG-574 คอมเมนต์ 2026-10-07 |
| เลือกพยาบาล/นักกายภาพฯ ก่อน S03 เสร็จ (E5) | **รับค่าได้** ทั้งใน KYC และคำขอเปลี่ยน — ยังไม่มีการตรวจใบประกอบฯ จนกว่า S03 (PYG-558) จะมา | Story E5 |

---

## 2. ค่าของวิชาชีพ (R1, S01-AC2)

| ค่า (ส่งผ่าน API) | ไทย | English | ต้องมีใบประกอบฯ (S03) |
|---|---|---|---|
| `general_caregiver` | ผู้ดูแลทั่วไป | General caregiver | ไม่ต้อง |
| `nurse` | พยาบาล | Nurse | ต้อง |
| `physiotherapist` | นักกายภาพบำบัด | Physiotherapist | ต้อง |

- ค่าตรงกับ `caregivers_profession_check` และ `care_activity_professions_profession_check` ใน DB
- ข้อความแสดงผลเป็นหน้าที่ของ FE (`src/lib/professions.ts`) — BE ส่งเฉพาะค่า ไม่ส่งข้อความ
- ผู้ดูแลเดิมทุกคน (85 แถว ณ 2026-10-07) มีค่า `general_caregiver` จาก migration (R4, S01-AC5)

```graphql
"""วิชาชีพของผู้ดูแล — ค่าตรงกับ CHECK caregivers_profession_check"""
enum CaregiverProfession {
  general_caregiver
  nurse
  physiotherapist
}
```

---

## 3. Field `profession` ใน type เดิม

### 3.1 ฝั่งอ่าน — เพิ่ม field ใหม่อย่างเดียว ไม่ลบ/ไม่เปลี่ยนชนิดของ field เดิม (client เก่าไม่พัง)

| ที่ | Field | หน้าที่ใช้ |
|---|---|---|
| `type Caregiver` | `profession: CaregiverProfession!` | `myCaregiverProfile`, `kycStatus { caregiver }`, `adminKycDetail { caregiver }`, `submitKyc` / `resubmitKyc` / `approveKyc` ฯลฯ ที่คืน `Caregiver` |
| `type CaregiverSummary` | `profession: CaregiverProfession!` | `searchCaregivers` (หน้า List ฝั่ง Elder · S01-AC3) |
| REST `GET /api/v1/caregivers/:id/public` | `"profession": "nurse"` | หน้า Profile ฝั่ง Elder (S01-AC4) |

- ไม่มี null — ทุกแถวมีค่า (NOT NULL + backfill)
- R6: หน้า List และ `/public` คืนเฉพาะผู้ดูแลที่ `is_searchable = true` และ `kyc_status = 'verified'` อยู่แล้ว ไม่มีเงื่อนไขใหม่
- E1: ผู้ดูแลที่ยังไม่เคยส่ง KYC แต่มีแถว `caregivers` จะได้ค่า `general_caregiver` (DEFAULT) — **FE ห้ามเติมค่านี้ลงฟอร์ม KYC ครั้งแรก**
  (FE ทำไว้แล้ว: `resolveProfession(..., 'none')` เฉพาะหน้า resubmit)

```graphql
query GetCaregiverProfile {
  myCaregiverProfile { id fullName profession kycStatus }
}
```

```json
{ "data": { "myCaregiverProfile": { "id": "6f1c…", "fullName": "สมใจ ใจดี", "profession": "general_caregiver", "kycStatus": "verified" } } }
```

```json
// GET /api/v1/caregivers/6f1c…/public  (ตัดมาเฉพาะส่วนที่เกี่ยว)
{ "id": "6f1c…", "first_name": "สมใจ", "skills": ["bathing"], "profession": "nurse", "verified_at": "2026-09-01T03:00:00.000Z" }
```

### 3.2 ฝั่งเขียน — `KycInput.profession` (S01-AC1, E3, E4)

```graphql
input KycInput {
  # …field เดิมทั้งหมดไม่เปลี่ยน…
  """บังคับ — general_caregiver | nurse | physiotherapist (ไม่ส่ง = PROFESSION_REQUIRED)"""
  profession: String
}
```

**ทำไมขาเข้าเป็น `String` (nullable) ไม่ใช่ `CaregiverProfession!`** — ถ้าเป็น `!` หรือ enum, GraphQL จะปฏิเสธ
ตั้งแต่ชั้นตรวจ schema ก่อนถึงโค้ดของเรา ได้ error ทั่วไป (`BAD_USER_INPUT`, HTTP 400) แทน code ที่ตกลงกัน
— บทเรียนเดียวกับ PYG-415 (`@Length` ใน DTO ตอบ `BAD_REQUEST` ก่อนถึงตัวเช็คใน service) ช่องนี้จึง "บังคับตาม contract"
แต่ตรวจที่ service:

| ส่งมา | ผล |
|---|---|
| ไม่ส่ง / `null` / `""` / มีแต่ช่องว่าง | `PROFESSION_REQUIRED` — **ไม่เติมค่าเริ่มต้นให้** (E3) |
| ค่าที่ไม่ใช่ 3 ค่าใน §2 (รวมตัวพิมพ์ใหญ่ เช่น `"NURSE"`) | `PROFESSION_INVALID` — ตรวจก่อนถึง DB (E4) · DB มี CHECK กันอีกชั้น |
| ค่าที่ถูกต้อง | บันทึกลง `caregivers.profession` ในทรานแซคชันเดียวกับข้อมูล KYC |

- ใช้กับทั้ง `submitKyc` และ `resubmitKyc` (input ตัวเดียวกัน)
- ตรวจ `profession` **ก่อน** ตรวจสถานะ KYC — client เก่าที่ไม่ส่งค่าเห็น `PROFESSION_REQUIRED` เสมอ ไม่ว่าสถานะใด
- E2: ผู้ดูแลที่ถูกปฏิเสธแล้วส่งใหม่ เปลี่ยนวิชาชีพได้ทันทีผ่าน `resubmitKyc` ไม่เข้าคิวตรวจแยก (เพราะยังไม่เคยอนุมัติ
  และ KYC ทั้งชุดจะถูกแอดมินตรวจอยู่แล้ว) · การเปลี่ยนถูกบันทึกใน `caregiver_edit_logs` action `resubmit` เป็น
  `{ field: "profession", oldValue: "\"general_caregiver\"", newValue: "\"nurse\"" }` แบบเดียวกับ field อื่น
- ผู้ดูแลที่ `verified` แล้วส่ง `submitKyc` ไม่ได้อยู่แล้ว (เดิม: `ConflictException`) → ต้องใช้ §4

```graphql
mutation SubmitKyc($input: KycInput!) {
  submitKyc(input: $input) { id kycStatus profession }
}
```

```jsonc
// variables
{ "input": { "fullName": "สมใจ ใจดี", "idCardNumber": "1234567890121", "phone": "0812345678",
             "skills": ["bathing"], "experienceYears": 3, "documentIds": ["…"], "profession": "nurse" } }
// response
{ "data": { "submitKyc": { "id": "6f1c…", "kycStatus": "pending", "profession": "nurse" } } }
```

```jsonc
// client เก่าที่ไม่ส่ง profession
{ "errors": [ { "message": "กรุณาเลือกวิชาชีพ",
                "extensions": { "code": "PROFESSION_REQUIRED", "allowed": ["general_caregiver", "nurse", "physiotherapist"] } } ],
  "data": null }
```

---

## 4. คำขอเปลี่ยนวิชาชีพหลัง KYC อนุมัติ (R5, S01-AC6)

### 4.1 วงจรของคำขอ

```
ผู้ดูแล (verified)                         แอดมิน
requestProfessionChange ─▶ pending ─┬─▶ approveProfessionChangeRequest ─▶ approved  (caregivers.profession = ค่าใหม่)
                                    ├─▶ rejectProfessionChangeRequest  ─▶ rejected  (ค่าเดิมคงอยู่ + เหตุผล)
cancelProfessionChangeRequest ──────┴─▶ cancelled (ค่าเดิมคงอยู่)
```

- มีคำขอ `pending` ได้ **ทีละ 1 คำขอต่อผู้ดูแล** — ตัดสินแล้ว (approved / rejected / cancelled) ขอใหม่ได้ทันที
- ระหว่าง `pending`: `profession` ทุกที่ยังเป็นค่าเดิม (Elder เห็นค่าเดิม ผู้ดูแลรับงานด้วยค่าเดิมได้)
- ขอได้เฉพาะ `kycStatus = 'verified'` — สถานะอื่นใช้ฟอร์ม KYC (`submitKyc` / `resubmitKyc`) แทน
- ผู้ดูแลเห็น/ยกเลิกได้เฉพาะคำขอของตัวเอง — ตรวจจาก user ที่ล็อกอิน ไม่ใช่จาก id ที่ส่งมา

### 4.2 Type

```graphql
enum ProfessionChangeStatus { pending approved rejected cancelled }

type ProfessionChangeRequest {
  id: ID!
  caregiverId: ID!
  fromProfession: CaregiverProfession!   # ค่า ณ ตอนยื่นคำขอ
  toProfession: CaregiverProfession!
  status: ProfessionChangeStatus!
  licenseNumber: String                  # S03 (PYG-558) — ตอนนี้ null เสมอ
  licenseExpiresAt: String               # S03 — 'YYYY-MM-DD' · ตอนนี้ null เสมอ
  licenseDocument: KycDocument           # S03 — FE เลือก { id fileName signedUrl } · ตอนนี้ null เสมอ
  rejectionReason: String                # มีเฉพาะ rejected
  requestedAt: DateTime!
  reviewedAt: DateTime                   # เวลาที่แอดมินตัดสิน (approved / rejected) · cancelled = null
}
```

- field ใบประกอบฯ 3 ตัว **มีใน type ตั้งแต่ตอนนี้** เพื่อให้ `REQUEST_FIELDS` ของ FE validate ผ่านโดยไม่ต้องแก้
  S03 จะเติมค่าและเพิ่ม field ขาเข้าใน `ProfessionChangeInput` (เพิ่มอย่างเดียว ไม่ breaking)

### 4.3 `myProfessionChangeRequest` — คำขอล่าสุดของตัวเอง (ผู้ดูแล · role 2)

```graphql
type Query { myProfessionChangeRequest: ProfessionChangeRequest }
```

- คืนคำขอ **ล่าสุด** ไม่ว่าสถานะใด · `null` = ไม่เคยขอ (หรือยังไม่มีแถว `caregivers`)

```json
{ "data": { "myProfessionChangeRequest": {
  "id": "0b9e…", "fromProfession": "general_caregiver", "toProfession": "nurse", "status": "pending",
  "licenseNumber": null, "licenseExpiresAt": null, "licenseDocument": null,
  "rejectionReason": null, "requestedAt": "2026-10-17T04:12:00.000Z", "reviewedAt": null } } }
```

### 4.4 `requestProfessionChange` — ยื่นคำขอ (ผู้ดูแล · role 2)

```graphql
input ProfessionChangeInput {
  """general_caregiver | nurse | physiotherapist"""
  profession: String!
}
type Mutation { requestProfessionChange(input: ProfessionChangeInput!): ProfessionChangeRequest! }
```

| เงื่อนไข | ผล |
|---|---|
| `profession` ว่าง / มีแต่ช่องว่าง | `PROFESSION_REQUIRED` |
| ค่านอกรายการ | `PROFESSION_INVALID` |
| `kycStatus` ไม่ใช่ `verified` (หรือไม่มีแถว `caregivers`) | `PROFESSION_CHANGE_NOT_ALLOWED` + `kycStatus` |
| เท่ากับวิชาชีพปัจจุบัน | `PROFESSION_UNCHANGED` |
| มีคำขอ `pending` อยู่แล้ว | `PROFESSION_CHANGE_ALREADY_PENDING` + `requestId` |
| ผ่านทั้งหมด | คืนคำขอ `status: pending` — `caregivers.profession` **ไม่เปลี่ยน** |

ลำดับการตรวจ (เจอข้อแรกที่ไม่ผ่าน ตอบ code นั้น): ค่าที่ส่งมา (`REQUIRED` / `INVALID`) → สถานะ KYC (`NOT_ALLOWED`)
→ มีคำขอค้าง (`ALREADY_PENDING`) → ซ้ำค่าเดิม (`UNCHANGED`) — เช่น มีคำขอค้างอยู่แล้วและขอค่าเดิมซ้ำ จะได้ `ALREADY_PENDING`

```jsonc
// variables
{ "input": { "profession": "nurse" } }
// response
{ "data": { "requestProfessionChange": { "id": "0b9e…", "fromProfession": "general_caregiver", "toProfession": "nurse",
            "status": "pending", "requestedAt": "2026-10-17T04:12:00.000Z", "reviewedAt": null } } }
```

### 4.5 `cancelProfessionChangeRequest` — ยกเลิกคำขอของตัวเอง (ผู้ดูแล · role 2)

```graphql
type Mutation { cancelProfessionChangeRequest(id: ID!): ProfessionChangeRequest! }
```

| เงื่อนไข | ผล |
|---|---|
| ไม่พบ หรือไม่ใช่คำขอของผู้เรียก | `PROFESSION_CHANGE_NOT_FOUND` (ไม่บอกว่ามีอยู่ — กันการเดา id ของคนอื่น) |
| ไม่ใช่ `pending` | `PROFESSION_CHANGE_NOT_PENDING` + `status` |
| ผ่าน | คืนคำขอ `status: cancelled` |

```json
{ "data": { "cancelProfessionChangeRequest": { "id": "0b9e…", "status": "cancelled" } } }
```

### 4.6 ฝั่งแอดมิน (role 3 / 4) — คิวตรวจ อนุมัติ ปฏิเสธ

FE ยังไม่มีหน้าแอดมินสำหรับส่วนนี้ (PYG-576 ระบุว่าแอดมินตรวจ "จากหน้าแอดมิน") — BE เตรียม operation ไว้ให้ครบวงจร AC6

```graphql
input AdminProfessionChangeRequestsInput {
  status: ProfessionChangeStatus = pending   # pending เรียงเก่าสุดก่อน (คิว) · สถานะอื่นเรียงตัดสินล่าสุดก่อน
  page: Int = 1
  limit: Int = 20                            # 1–50
}

type AdminProfessionChangeRequest {
  # …ทุก field ของ ProfessionChangeRequest…
  caregiverNumber: String
  caregiverName: String!
  reviewerName: String        # ชื่อแอดมินที่ตัดสิน (approved / rejected)
}

type AdminProfessionChangeRequestPage {
  items: [AdminProfessionChangeRequest!]!
  total: Int!
  page: Int!
  totalPages: Int!
}

input RejectProfessionChangeInput {
  id: ID!
  reason: String!             # บังคับ · ไม่เกิน 500 ตัวอักษร (ตรวจที่ DTO แบบ rejectProfilePhoto)
}

type Query { adminProfessionChangeRequests(input: AdminProfessionChangeRequestsInput): AdminProfessionChangeRequestPage! }
type Mutation {
  approveProfessionChangeRequest(id: ID!): ProfessionChangeRequest!
  rejectProfessionChangeRequest(input: RejectProfessionChangeInput!): ProfessionChangeRequest!
}
```

| เงื่อนไข (approve / reject) | ผล |
|---|---|
| ไม่พบ id | `PROFESSION_CHANGE_NOT_FOUND` |
| ไม่ใช่ `pending` (ถูกยกเลิก/ตัดสินไปแล้ว) | `PROFESSION_CHANGE_NOT_PENDING` + `status` |
| approve ผ่าน | `caregivers.profession = toProfession` + บันทึก log **ในทรานแซคชันเดียวกัน** · คืน `status: approved` |
| reject ผ่าน | ค่าเดิมคงอยู่ · บันทึกเหตุผล · คืน `status: rejected` + `rejectionReason` |

```jsonc
// rejectProfessionChangeRequest — variables
{ "input": { "id": "0b9e…", "reason": "ภาพใบประกอบฯ ไม่ชัด อ่านวันหมดอายุไม่ได้" } }
// response
{ "data": { "rejectProfessionChangeRequest": { "id": "0b9e…", "status": "rejected",
            "rejectionReason": "ภาพใบประกอบฯ ไม่ชัด อ่านวันหมดอายุไม่ได้", "reviewedAt": "2026-10-18T02:00:00.000Z" } } }
```

- **ยังไม่มีการแจ้งเตือน** ตอนอนุมัติ/ปฏิเสธ — `NotificationType` เป็น Postgres enum เพิ่มค่าต้อง migrate (ดู §9)
  ระหว่างนี้ FE เห็นผลจาก `myProfessionChangeRequest` (`fetchPolicy: 'network-only'` ตามที่ FE วางไว้)

---

## 5. Error contract

### 5.1 รูปแบบ — HTTP 200 + `extensions.code` (★ ไม่ใช่ 422)

การ์ดเสนอ "ตอบ 422 ตามแนวที่ repo ใช้" แต่ฝั่ง GraphQL ของ repo นี้ไม่ได้ส่ง HTTP status ของ business error ออกไป:
Apollo ตอบ HTTP 200 แล้วใส่ error ใน `errors[]` และ FE อ่าน `extensions.code` (`extractGraphQLErrorCode`)
— แพตเทิร์นเดียวกับ `FieldLockedError`, `ConsentError`, `FamilyGroupError` และ PYG-601
(`UnprocessableEntityException` ของ Nest ที่ใช้ใน booking ก็ออกมาเป็น HTTP 200 เช่นกัน แต่ `@nestjs/apollo`
แปลง 422 เป็น code `BAD_USER_INPUT` ทั่วไป — FE แยกไม่ออกว่าไม่ได้เลือก หรือเลือกค่าผิด)

```jsonc
{ "errors": [ { "message": "<ข้อความภาษาไทย แสดงให้ผู้ใช้ได้>", "extensions": { "code": "<CODE>", "...": "ข้อมูลเสริม" } } ], "data": null }
```

### 5.2 รายการ code (ห้ามเปลี่ยนสตริงโดยไม่บอกทีม FE)

| code | เมื่อไร | extensions เสริม | ข้อความ (message) |
|---|---|---|---|
| `PROFESSION_REQUIRED` | ไม่ส่ง / ค่าว่าง (KYC, คำขอเปลี่ยน) | `allowed: string[]` | กรุณาเลือกวิชาชีพ |
| `PROFESSION_INVALID` | ค่านอก 3 ค่า | `allowed: string[]`, `received: string` | วิชาชีพไม่ถูกต้อง |
| `PROFESSION_CHANGE_NOT_ALLOWED` | ขอเปลี่ยนตอน KYC ยังไม่อนุมัติ | `kycStatus: string` | ขอเปลี่ยนวิชาชีพได้หลังยืนยันตัวตนผ่านแล้ว… |
| `PROFESSION_UNCHANGED` | ขอเปลี่ยนเป็นค่าเดิม | `profession: string` | วิชาชีพใหม่ต้องไม่ซ้ำกับวิชาชีพปัจจุบัน |
| `PROFESSION_CHANGE_ALREADY_PENDING` | มีคำขอรอตรวจอยู่แล้ว | `requestId: string` | มีคำขอเปลี่ยนวิชาชีพที่รอตรวจอยู่แล้ว… |
| `PROFESSION_CHANGE_NOT_FOUND` | id ไม่พบ / ไม่ใช่ของผู้เรียก | — | ไม่พบคำขอเปลี่ยนวิชาชีพ |
| `PROFESSION_CHANGE_NOT_PENDING` | ยกเลิก/ตัดสินคำขอที่จบไปแล้ว | `status: string` | คำขอนี้ไม่ได้อยู่ระหว่างรอตรวจแล้ว |

error อื่นที่อาจเจอ (ไม่ใช่ของ contract นี้): `FORBIDDEN` (role ไม่ตรง), `UNAUTHENTICATED`, `BAD_REQUEST`
(DTO ของ `reason` ใน reject ไม่ผ่าน), `INTERNAL_SERVER_ERROR` + `status: 409` (ส่ง KYC ตอน `pending`/`verified` —
พฤติกรรมเดิมของ `ConflictException` ซึ่ง `@nestjs/apollo` ไม่มี code เฉพาะให้)

---

## 6. ที่เก็บคำขอ — `caregiver_edit_logs` (ไม่ต้อง migrate)

ทุกเหตุการณ์ของคำขอเป็น **แถวใหม่** (append-only ไม่ UPDATE แถวเก่า) ในตารางที่มีอยู่แล้ว:

| `action` | `edited_by` | เกิดเมื่อ |
|---|---|---|
| `profession_change_request` | user ของผู้ดูแล | ยื่นคำขอ — `id` ของแถวนี้ = `ProfessionChangeRequest.id` |
| `profession_change_cancel` | user ของผู้ดูแล | ยกเลิก |
| `profession_change_approve` | user ของแอดมิน | อนุมัติ (ทรานแซคชันเดียวกับ UPDATE `caregivers.profession`) |
| `profession_change_reject` | user ของแอดมิน | ปฏิเสธ |

`field_changes` ของทุกแถว — รูปเดียวกับที่ `computeFieldChanges` เขียน (หน้า KYC review ของแอดมินแสดงได้ทันที
ใน `editHistory`) บวก key เสริมที่ GraphQL type `FieldChange` ไม่เปิดเผย:

```jsonc
[{ "field": "profession",
   "oldValue": "\"general_caregiver\"",   // JSON.stringify — แบบเดียวกับ log อื่น
   "newValue": "\"nurse\"",
   "requestId": "0b9e…",                  // ทุกแถวของคำขอเดียวกันมีค่าเดียวกัน
   "reason": "ภาพใบประกอบฯ ไม่ชัด" }]     // เฉพาะ profession_change_reject
```

- สถานะของคำขอ = แถวตัดสิน (cancel / approve / reject) ที่มี `requestId` ตรงกัน · ไม่มี = `pending`
- "pending ได้ทีละ 1" และ "ตัดสินได้ครั้งเดียว" บังคับที่ BE: ทุก operation ที่เขียน ล็อกแถว `caregivers`
  ของผู้ดูแลคนนั้นด้วย `SELECT … FOR UPDATE` ก่อนตรวจและเขียน → คำขอซ้อนจากสองแท็บ/สองแอดมินถูกต่อคิว ไม่ซ้อนกัน
- `created_at` ของแถวเหล่านี้ใช้ `clock_timestamp()` (เวลาหลังได้ล็อก) แทน `NOW()` (เวลาเริ่มทรานแซคชัน)
  เพื่อให้ลำดับเวลาตรงกับลำดับที่ได้ล็อกเสมอ

ข้อแลกเปลี่ยนที่ยอมรับ (เทียบกับตารางใหม่):

| ข้อดี | ข้อเสีย |
|---|---|
| ไม่มี migration · deploy ได้ทันทีโดยไม่ต้องรอ Sammy | กติกา "pending ทีละ 1" อยู่ในโค้ด ไม่มี unique index ใน DB กันอีกชั้น |
| ประวัติการเปลี่ยนวิชาชีพอยู่ที่เดียวกับประวัติแก้ไขอื่น (R5 + "บันทึกลง `caregiver_edit_logs`" ใน story) | คิวแอดมินอ่าน JSON (`field_changes @> …`) — ตารางยังเล็ก (ไม่มี index บน `action`) ถ้าโตมากค่อยเพิ่ม index ทีหลัง |
| ย้ายไปตารางจริงทีหลังได้ด้วยการอ่านแถวเหล่านี้ (ข้อมูลครบ) | ห้ามใครลบ/แก้แถวใน `caregiver_edit_logs` เอง — แถวเหล่านี้คือสถานะของคำขอ |

---

## 7. สิ่งที่ FE ต้องทำเมื่อ BE deploy (ทุกจุดมีป้าย `TODO(PYG-575)` ใน FE อยู่แล้ว)

1. `src/graphql/queries.ts`: `PROFESSION_FIELD = "profession"` — ใช้ได้ทั้ง 4 query (`GetCaregiverProfile`, `GetKycStatus`,
   `AdminKycDetail`, `SearchCaregivers`) · **`CUSTOM_SKILLS_FIELD` ยังต้องว่างไว้** (ดู §9 ข้อ 2)
2. `KycStep4.tsx`: ใส่ `kycInput.profession = step1Data.profession` (อย่าใส่ `customSkills` — `KycInput` ไม่มี field นี้ จะโดนปฏิเสธทั้ง mutation)
3. `useProfessionChange.ts`: เปลี่ยน mock เป็น `MY_PROFESSION_CHANGE_REQUEST` / `REQUEST_PROFESSION_CHANGE` /
   `CANCEL_PROFESSION_CHANGE_REQUEST` ตามที่เขียนไว้ — input ตอนนี้ส่งแค่ `{ profession }` (field ใบประกอบฯ มากับ S03)
4. แปลง error code ใน §5.2 เป็นข้อความ (FE มีข้อความใต้ช่องของ `PROFESSION_REQUIRED` อยู่แล้ว)
5. หน้า Profile (`/public`) อ่าน `data.profession` อยู่แล้ว — ไม่ต้องแก้

---

## 8. ลำดับเมื่อจะเพิ่มวิชาชีพใหม่ (เช่น ผู้ช่วยพยาบาล)

1. BE เพิ่มค่าใน enum `CaregiverProfession` และรายการที่ service ตรวจ → deploy (ยังไม่มีแถวไหนใช้ค่าใหม่ จึงไม่พัง)
2. migration ใหม่: `DROP` + `ADD CONSTRAINT caregivers_profession_check` (และ `care_activity_professions_profession_check`) ให้รวมค่าใหม่ → Sammy deploy
3. FE เพิ่มใน `PROFESSIONS` (FE มี fallback ค่าที่ไม่รู้จักอยู่แล้ว)

**ห้ามสลับข้อ 1 กับ 2** — ถ้า DB รับค่าใหม่ก่อน แล้วมีแถวที่ใช้ค่านั้น ทุก query ที่คืน `Caregiver.profession` ของแถวนั้นจะ error
("Enum CaregiverProfession cannot represent value")

---

## 9. ประเด็นที่ยังเปิดอยู่ (ไม่บล็อก S01 แต่ต้องมีคนตัดสิน)

1. **แจ้งเตือนผลคำขอ** — อยากได้ notification `profession_change_approved` / `_rejected` ต้องเพิ่มค่าใน Postgres enum
   `"NotificationType"` = migration → ทำเป็นการ์ดแยก (แนวเดียวกับ `profile_photo_approved` ของ PYG-508)
2. **`customSkills` (ทักษะอื่นๆ ที่ผู้ดูแลพิมพ์เอง)** — FE ทำหน้าจอไว้ใน PYG-576 แต่ **ไม่อยู่ใน story PYG-556** และ DB ไม่มีคอลัมน์
   (`caregivers` ไม่มี `custom_skills`) → ต้องมีการ์ด + migration ของตัวเอง ระหว่างนี้ FE ต้องไม่ส่ง/ไม่ขอ field นี้
3. **S03 (PYG-558)** — `uploadKycDocument` ยังรับแค่ `id_card_front | id_card_selfie | certificate` · เมื่อรับ `professional_license`
   แล้ว ให้เพิ่ม `licenseDocumentId`, `licenseNumber`, `licenseExpiresAt` ใน `ProfessionChangeInput` และเก็บ `requestId`
   คู่กับเอกสาร (คอลัมน์ `license_number` / `expires_at` ใน `kyc_documents` มีแล้วจาก PYG-586)
4. **หน้าแอดมินของคิวคำขอเปลี่ยนวิชาชีพ** — ยังไม่มีการ์ด FE · ระหว่างนี้แอดมินเห็นคำขอใน `adminKycDetail.editHistory`
   ของผู้ดูแลคนนั้น แต่กดอนุมัติ/ปฏิเสธได้ผ่าน API เท่านั้น
