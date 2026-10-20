# S08 · ADL & Flags — FE/BE API contract

การ์ดแม่: **PYG-563** · การ์ด API ที่อ้างใน migration: **PYG-607** · BE: **PYG-609** · FE: **PYG-610**

สถานะ: **Draft v0.1 สำหรับรีวิว — ยังไม่ถือว่า FE/BE รับ contract หรือปิด DoD**

จัดทำ: 17 ต.ค. 2026 (Asia/Bangkok) · ส่งมอบเอกสารเท่านั้น ไม่มีการเพิ่ม API หรือแก้ schema ในการ์ดนี้

## 1. ฐานข้อมูลอ้างอิงและสถานะการตัดสินใจ

ใช้มติที่ผู้ใช้ส่งมาเป็นหลัก: รหัส Flags จาก PYG-638 วันที่ 8 ต.ค. 2026; รหัส ADL จาก PYG-642 และกติกาไม่แน่ใจที่ Sammy เคาะวันที่ 9 ต.ค. 2026; ภาพตาราง ADL ที่แนบยืนยัน key และช่วงคะแนนซ้ำอีกครั้ง

สิ่งที่ยืนยันแล้ว:

- ADL ใช้ 10 key ใน §2 เท่านั้น; คะแนนรวมเต็ม 20
- ไม่แน่ใจ = `null`; ทุก key ต้องมีครบ; คิดคะแนนและเทียบกติกาทักษะโดยใช้ `null` เป็น 0
- `unsureCount >= 3` ให้ `hasUnsureFlag = true`; ไม่ใส่ `unsure` ใน `flags`
- ญาติเลือก Flags ได้เฉพาะ 9 รหัสใน §3; `noSpecialConditions` แยกจาก Flags
- Client ไม่ส่งคะแนนรวม จำนวนข้อไม่แน่ใจ Flag ของระบบ ผู้ประเมิน หรือเวลาประเมิน

**ส่วนที่ยังไม่มีมติจาก story ให้ถือเป็นข้อเสนอของ draft นี้ทั้งหมด** โดยเฉพาะรูปทรง input, สิทธิ์อ่าน, validation เพิ่มเติม, ที่เก็บรายการข้อ และการบังคับประเมินในเส้นทางจองที่ยังไม่มีโปรไฟล์ ห้ามตีความว่า Sammy หรืออาจารย์อนุมัติแล้ว

### ผลตรวจเทียบ repository

ตรวจ checkout `payung_backend` commit `3eeceb845b96303af28de60235994a6e881f97f1`:

| เรื่อง | ปัจจุบัน | ผลต่อ contract |
| --- | --- | --- |
| GraphQL | NestJS code-first + Apollo; `src/schema.gql` เป็นไฟล์ generated | SDL ในเอกสารนี้เป็นสิ่งที่จะเพิ่มผ่าน source ของ PYG-609 ไม่แก้ generated schema ด้วยมือ |
| Assessment API | ยังไม่พบ `submitCareRecipientAssessment`, `careRecipientAssessment`, type ผลประเมิน หรือ `hasAssessment` ใน schema | ชื่อเหล่านี้เป็นข้อเสนอใหม่ ไม่ใช่ endpoint ที่เรียกได้แล้ว |
| โปรไฟล์ส่วนตัว | REST `GET /api/v1/patient/care-recipients`; `CareRecipientResponse` | ต้องเพิ่ม `hasAssessment: boolean` ใน response ของโปรไฟล์ส่วนตัวด้วย |
| โปรไฟล์ในกลุ่ม | GraphQL `groupCareRecipients(groupId: ID!): [GroupCareRecipient!]!` | เพิ่ม `GroupCareRecipient.hasAssessment: Boolean!` |
| ตัวเลือกจองแทน | `groupBookingRecipients` ใช้ `memberUserId`, `hasProfile`; ยังไม่มี ID ของโปรไฟล์ในผลลัพธ์นี้ | `hasProfile` ไม่ใช่ `hasAssessment`; ต้องปิดประเด็น D6 ก่อนเปิด assessment gate ใน member-only flow |
| สร้าง booking | GraphQL `createBookingOnBehalf(input: CreateBookingOnBehalfInput!): BookingSummary!` และ REST `POST /api/v1/bookings` | ไม่มี mutation `createBooking` ใน schema ปัจจุบัน; gate ใหม่ต้องครอบคลุมสองเส้นทางจริง |
| ตารางผลประเมิน | `CareRecipientAssessment` มี unique `careRecipientId`, JSONB `adlAnswers`, คะแนน, Flags, `assessedBy`, `assessedAt`, `createdAt`, `updatedAt` และ `careGroup` ที่ nullable | เก็บผลสมบูรณ์ครั้งล่าสุด 1 แถวต่อผู้สูงอายุ; `updatedAt` ไม่มี trigger ต้องตั้งเอง |
| Draft | migration PYG-608 ระบุไม่เก็บคำตอบค้าง ไม่มีสถานะ draft | v1 ไม่มี draft operation; หากเปลี่ยนมติ E1 ต้องเพิ่ม operation และนิยาม `hasAssessment` แยก |
| Privacy | DB เปิด RLS ไม่มี client policy; `care_recipients` เป็น soft delete | BE ต้องตรวจสิทธิ์เอง และห้ามอ่านผลของโปรไฟล์ที่ลบแล้ว แม้แถว assessment ยังอยู่ |
| Error | consent/family-group ใช้ `GraphQLError` ให้ FE อ่าน `extensions.code` ตรง ๆ | ห้ามพึ่งการแปลง Nest exception โดยไม่ตรวจ response จริง |

Git history ใน checkout มี merge PR [#113](https://github.com/Payung-Team/payung_backend/pull/113) (`4b4f9a5`) และ [#118](https://github.com/Payung-Team/payung_backend/pull/118) (`fc78954`) แล้ว จึงไม่ใช้ข้อความเก่า “รอ gate” เป็นสถานะของ branch นี้ แต่ไม่ได้ยืนยันว่า deploy ใน environment ใดแล้ว การอ่านสถานะ PR สดผ่านเว็บไม่สำเร็จและ CLI ยังไม่ได้ login

## 2. ADL codes และคำตอบ

`code` เป็น lowercase แบบ case-sensitive ห้ามแปลหรือเปลี่ยนตัวสะกด ค่า `value` รับเฉพาะจำนวนเต็มตามรายการ หรือ JSON `null`

| code | ค่าคะแนนที่รับ | ไม่แน่ใจ |
| --- | --- | --- |
| `feeding` | `0`, `1`, `2` | `null` |
| `grooming` | `0`, `1` | `null` |
| `transfers` | `0`, `1`, `2`, `3` | `null` |
| `toilet_use` | `0`, `1`, `2` | `null` |
| `mobility` | `0`, `1`, `2`, `3` | `null` |
| `dressing` | `0`, `1`, `2` | `null` |
| `stairs` | `0`, `1`, `2` | `null` |
| `bathing` | `0`, `1` | `null` |
| `bowels` | `0`, `1`, `2` | `null` |
| `bladder` | `0`, `1`, `2` | `null` |

ตัวเลือกไม่แน่ใจแสดง **“ไม่แน่ใจ” / “Not sure”** และส่ง `null` ไม่ใช่ `"unsure"`, `-1`, `"null"`, string ตัวเลข หรือการละข้อไว้

**ยังขาดข้อความอธิบายตัวเลือกรายคะแนนที่อาจารย์ยืนยัน** เช่น feeding คะแนน 0/1/2 หมายถึงความสามารถใด ภาพและมติที่ได้รับยืนยันเฉพาะรหัส/ช่วงคะแนน เอกสารนี้ไม่แต่งความหมายทางคลินิกเพิ่ม ให้ Sammy/เจ้าของ story แนบรายการข้อความ TH/EN ที่อนุมัติก่อน FE ทำแบบฟอร์มฉบับสุดท้าย (D1)

### การคำนวณและการเก็บ

- ต้องมีแต่ละ `code` ครบ 10 ข้อและไม่ซ้ำ; ไม่สนลำดับใน request
- `value: null` คือคำตอบที่สมบูรณ์หนึ่งข้อ แต่การไม่มีข้อ หรือไม่มี property `value` คือยังไม่ตอบ → `ASSESSMENT_INCOMPLETE`
- แปลง list บน API เป็น object ใน `adl_answers` ที่มี key ครบ 10 ข้อเสมอ เก็บ `null` ตามจริง ไม่แทนด้วย 0 ในข้อมูลที่เก็บหรือส่งกลับ
- `adlTotalScore = sum(value ?? 0)`; ช่วง `0..20`
- `unsureCount = count(value === null)`; ช่วง `0..10`
- `hasUnsureFlag = unsureCount >= 3`; คำนวณใหม่ทุกครั้ง ไม่คง true จากครั้งก่อน
- เทียบกติกาทักษะด้วยคะแนนรายข้อ `value ?? 0` เช่น `mobility: null` เข้า rule 0–1 → `wheelchair_push`; ห้ามใช้คะแนนรวมแทนคะแนนรายข้อ
- grooming, toilet_use, stairs ยังไม่มี seed กติกาทักษะใน checkout นี้ แต่ต้องเก็บและรวมคะแนนตามปกติ ไม่ถือเป็น error

ตัวอย่างที่ยืนยันแล้ว:

```json
{"feeding":2,"grooming":null,"transfers":1,"toilet_use":2,"mobility":null,"dressing":1,"stairs":0,"bathing":0,"bowels":2,"bladder":2}
```

ผลคือ `adlTotalScore: 10`, `unsureCount: 2`, `hasUnsureFlag: false`

## 3. Flags และข้อความแสดงผล

ส่ง API เป็นรหัสในคอลัมน์แรกเท่านั้น ข้อความไทยอิงรายการที่ผู้ใช้ยืนยัน ส่วนข้อความอังกฤษด้านล่างเป็นคำแปลเสนอสำหรับ FE รีวิว ไม่ได้อ้างว่าอาจารย์อนุมัติแล้ว

| ค่าใน `flags` | ไทย | English (เสนอ) |
| --- | --- | --- |
| `ng_tube` | ใช้สายยางให้อาหาร | Uses a nasogastric feeding tube |
| `urinary_catheter` | ใช้สายสวนปัสสาวะ | Uses a urinary catheter |
| `oxygen` | ใช้ออกซิเจนหรือเครื่องช่วยหายใจ | Uses oxygen or a ventilator |
| `pressure_ulcer` | มีแผลกดทับ | Has a pressure ulcer |
| `injection` | ต้องฉีดยา | Requires injections |
| `end_of_life` | อยู่ในระยะท้าย | End-of-life care |
| `dementia` | สมองเสื่อมหรืออัลไซเมอร์ | Dementia or Alzheimer's disease |
| `diabetes` | เบาหวานที่ต้องเจาะน้ำตาลหรือคุมอาหาร | Diabetes requiring blood glucose checks or dietary management |
| `fall_risk` | เสี่ยงหกล้มหรือเคยล้มใน 6 เดือน | At risk of falling or has fallen in the past 6 months |

| Field แยก | ไทย | English (เสนอ) | ค่า |
| --- | --- | --- | --- |
| `noSpecialConditions` | ไม่มีเงื่อนไขพิเศษ | No special conditions | boolean |
| `hasUnsureFlag` | ไม่แน่ใจตั้งแต่ 3 ข้อ | Not sure about 3 or more ADL items | boolean ที่ BE คำนวณ |
| `dementiaSevere` | รุนแรง | Severe | boolean; มีความหมายเมื่อเลือก dementia |

`unsure`, `none`, `no_special_conditions`, `dementia_severe`, `severe` ไม่ใช่ค่าใน `flags` ส่งมา → `ASSESSMENT_FLAG_INVALID` สำหรับ S16 ให้แปลง `hasUnsureFlag: true` เป็น rule code `unsure` และแปลง `dementiaSevere: true` เป็น variant `severe` ของ code `dementia` ภายใน BE เท่านั้น

### กติกา Flags ที่เสนอให้ใช้ใน v1 (รอรับรอง D4)

| Input | ผล |
| --- | --- |
| `flags: []`, `noSpecialConditions: true` | รับ |
| Flags อย่างน้อยหนึ่งตัว, `noSpecialConditions: false` | รับ |
| Flags อย่างน้อยหนึ่งตัว, `noSpecialConditions: true` | `ASSESSMENT_FLAGS_CONFLICT` |
| `flags: []`, `noSpecialConditions: false` | `ASSESSMENT_INCOMPLETE` พร้อม `fields: ["flags", "noSpecialConditions"]` เพื่อบังคับยืนยันว่าไม่มีเงื่อนไข |
| Flags ซ้ำ เช่น `["oxygen", "oxygen"]` | `ASSESSMENT_FLAG_INVALID`; ไม่ deduplicate เงียบ ๆ |
| มี dementia และ `dementiaSevere` เป็น true/false | รับ; false = ไม่เลือกรุนแรง |
| มี dementia แต่ไม่ส่ง severity หรือส่ง null | `ASSESSMENT_INCOMPLETE`, `fields: ["dementiaSevere"]` |
| ไม่มี dementia แต่ส่ง severity เป็น true **หรือ false** | **ปฏิเสธ** `ASSESSMENT_FLAGS_CONFLICT`; ไม่เพิกเฉย |
| ไม่มี dementia และ severity หายหรือเป็น null | รับและเก็บ/คืน `dementiaSevere: null` |

`noSpecialConditions: true` อยู่ร่วมกับ `hasUnsureFlag: true` ได้ เพราะตัวหลังเป็น Flag ที่ระบบตั้งจาก ADL ไม่ใช่เงื่อนไขที่ญาติเลือก

Response `flags` มีเฉพาะรหัสที่ญาติเลือก จัดลำดับตามตาราง §3 เพื่อให้ผลอ่านคงที่ Client ห้ามใช้ลำดับเพื่อแปลความหมาย

## 4. GraphQL contract ที่เสนอ

ทุก GraphQL request ใช้ `POST /graphql`, JSON body และ `Authorization: Bearer <access token>` ชื่อ operation/type ต่อไปนี้ยังไม่อยู่ใน schema ปัจจุบัน

```graphql
input CareRecipientAssessmentAnswerInput {
  code: String!
  value: Int
}

input SubmitCareRecipientAssessmentInput {
  careRecipientId: ID!
  answers: [CareRecipientAssessmentAnswerInput!]!
  flags: [String!]!
  noSpecialConditions: Boolean!
  dementiaSevere: Boolean
}

type CareRecipientAssessmentAnswer {
  code: String!
  value: Int
}

type CareRecipientAssessment {
  careRecipientId: ID!
  answers: [CareRecipientAssessmentAnswer!]!
  adlTotalScore: Int!
  unsureCount: Int!
  flags: [String!]!
  noSpecialConditions: Boolean!
  hasUnsureFlag: Boolean!
  dementiaSevere: Boolean
  assessedAt: DateTime!
}

extend type Mutation {
  submitCareRecipientAssessment(
    input: SubmitCareRecipientAssessmentInput!
  ): CareRecipientAssessment!
}

extend type Query {
  careRecipientAssessment(careRecipientId: ID!): CareRecipientAssessment
}

extend type GroupCareRecipient {
  hasAssessment: Boolean!
}
```

`DateTime` ใช้ scalar เดิมของ repo ไม่ประกาศซ้ำ รหัสข้อและ Flags ใช้ String เพื่อให้ BE ตรวจ allowlist แล้วตอบ domain error code ได้ตรงตาม §8; ไม่ใช้ enum ที่จะถูก GraphQL ปฏิเสธก่อนเข้า business validation

`value` ต้อง nullable เพื่อรับไม่แน่ใจ แต่ **nullable ใน SDL ไม่ได้หมายความว่าส่ง property หายได้** PYG-609 ต้องรักษาความต่างระหว่าง omitted กับ explicit null จนถึง validation ห้ามตั้ง default null ก่อนตรวจ มิฉะนั้นข้อที่ยังไม่ตอบจะผ่านเป็นไม่แน่ใจ

### Fields บังคับและข้อจำกัด input

| Field | ต้องส่งหรือไม่ | ความหมาย |
| --- | --- | --- |
| `careRecipientId` | ต้องส่ง | ID ของโปรไฟล์ผู้สูงอายุ ไม่ใช่ `users.id`; ใน DB เป็น UUID |
| `answers` | ต้องส่ง | 10 entries ครบชุด; แต่ละ entry ต้องมี `code` และ property `value` |
| `flags` | ต้องส่งทุกครั้ง | ส่งทั้งหมด แม้เป็น `[]`; ห้าม merge กับครั้งก่อน |
| `noSpecialConditions` | ต้องส่งทุกครั้ง | boolean ไม่มี default ฝั่ง request |
| `dementiaSevere` | ตามเงื่อนไข §3 | ถ้าเลือก dementia ต้องส่ง true/false; ถ้าไม่เลือกให้ละไว้หรือส่ง null |

ไม่มี `adlTotalScore`, `unsureCount`, `hasUnsureFlag`, `assessedBy`, `assessedAt`, `createdAt`, `updatedAt`, `careGroup` ใน input ส่งมาใน GraphQL input จะถูก schema ปฏิเสธ ห้ามรับค่าทั้งนี้ผ่านช่องทางอื่นแล้วเขียนทับค่าที่ BE คำนวณ

## 5. Operation: บันทึก/แก้ไขทั้งชุด

`submitCareRecipientAssessment` เป็น upsert ตาม `careRecipientId`: ไม่มีผลเดิมให้สร้าง มีแล้วให้แทนคำตอบและ Flags ทั้งชุด ไม่ใช้ PATCH และไม่เก็บประวัติใน v1

1. ตรวจ auth และสิทธิ์ต่อโปรไฟล์ก่อนอ่านว่ามี assessment หรือไม่ (§7)
2. ตรวจ input ตามลำดับใน §8 เมื่อผิดต้องไม่เปลี่ยนผลเดิม
3. คำนวณคะแนน/unsure ใหม่จาก request ทั้งชุด
4. เขียนคำตอบ ค่าคำนวณ Flags, `assessedBy = authenticated users.id`, `assessedAt` และ `updatedAt` ด้วยเวลา server ใน transaction เดียวกัน; `createdAt` คงเดิมเมื่อแก้ไข
5. คืนผลที่บันทึกสำเร็จ โดย `answers` เรียงตามตาราง §2; `hasAssessment` ที่อ่านหลัง commit ต้องเป็น true

เวลาคืนเป็น UTC ISO 8601 เช่น `2026-10-17T03:00:00.000Z` (10:00 น. Bangkok) FE แปลง timezone ตอนแสดงผล ไม่ส่งเวลาจากเครื่อง client

ใน v1 ไม่มี revision precondition: คำขอที่เขียนทับสำเร็จภายหลังเป็นผลล่าสุด ไม่ merge คำตอบระหว่าง request การส่ง payload เดิมอีกครั้งไม่เพิ่มแถว แต่ถือเป็นการประเมินใหม่ จึงอัปเดต `assessedAt` อีกครั้ง ไม่รับประกัน idempotency ของเวลา

S09 มี `careGroup` ใน DB แล้ว: เมื่อ PYG-614 เปิดใช้งานต้องคำนวณกลุ่มจากคะแนนชุดเดียวกันใน transaction เดียวกับคะแนน ไม่ปล่อยกลุ่มเก่าคู่กับคะแนนใหม่; field กลุ่มใน API เป็นเจ้าของ S09 ไม่เพิ่มเป็น input ของ S08

### Request: สร้างครั้งแรก

GraphQL document:

```graphql
mutation SubmitAssessment($input: SubmitCareRecipientAssessmentInput!) {
  submitCareRecipientAssessment(input: $input) {
    careRecipientId
    answers { code value }
    adlTotalScore
    unsureCount
    flags
    noSpecialConditions
    hasUnsureFlag
    dementiaSevere
    assessedAt
  }
}
```

Variables:

```json
{
  "input": {
    "careRecipientId": "22222222-2222-4222-8222-222222222222",
    "answers": [
      {"code":"feeding","value":2},
      {"code":"grooming","value":null},
      {"code":"transfers","value":1},
      {"code":"toilet_use","value":2},
      {"code":"mobility","value":null},
      {"code":"dressing","value":1},
      {"code":"stairs","value":0},
      {"code":"bathing","value":0},
      {"code":"bowels","value":2},
      {"code":"bladder","value":2}
    ],
    "flags": ["diabetes"],
    "noSpecialConditions": false,
    "dementiaSevere": null
  }
}
```

Response (HTTP 200):

```json
{
  "data": {
    "submitCareRecipientAssessment": {
      "careRecipientId": "22222222-2222-4222-8222-222222222222",
      "answers": [
        {"code":"feeding","value":2},
        {"code":"grooming","value":null},
        {"code":"transfers","value":1},
        {"code":"toilet_use","value":2},
        {"code":"mobility","value":null},
        {"code":"dressing","value":1},
        {"code":"stairs","value":0},
        {"code":"bathing","value":0},
        {"code":"bowels","value":2},
        {"code":"bladder","value":2}
      ],
      "adlTotalScore": 10,
      "unsureCount": 2,
      "flags": ["diabetes"],
      "noSpecialConditions": false,
      "hasUnsureFlag": false,
      "dementiaSevere": null,
      "assessedAt": "2026-10-17T03:00:00.000Z"
    }
  }
}
```

### Request: แก้ไขครั้งถัดไป

ใช้ mutation document เดิมทุกตัวอักษร ส่งชุดใหม่ครบทั้งชุดดังนี้:

```json
{
  "input": {
    "careRecipientId": "22222222-2222-4222-8222-222222222222",
    "answers": [
      {"code":"feeding","value":2},
      {"code":"grooming","value":null},
      {"code":"transfers","value":1},
      {"code":"toilet_use","value":2},
      {"code":"mobility","value":null},
      {"code":"dressing","value":null},
      {"code":"stairs","value":0},
      {"code":"bathing","value":0},
      {"code":"bowels","value":2},
      {"code":"bladder","value":2}
    ],
    "flags": [],
    "noSpecialConditions": true
  }
}
```

Response (HTTP 200):

```json
{
  "data": {
    "submitCareRecipientAssessment": {
      "careRecipientId": "22222222-2222-4222-8222-222222222222",
      "answers": [
        {"code":"feeding","value":2},
        {"code":"grooming","value":null},
        {"code":"transfers","value":1},
        {"code":"toilet_use","value":2},
        {"code":"mobility","value":null},
        {"code":"dressing","value":null},
        {"code":"stairs","value":0},
        {"code":"bathing","value":0},
        {"code":"bowels","value":2},
        {"code":"bladder","value":2}
      ],
      "adlTotalScore": 9,
      "unsureCount": 3,
      "flags": [],
      "noSpecialConditions": true,
      "hasUnsureFlag": true,
      "dementiaSevere": null,
      "assessedAt": "2026-10-17T04:00:00.000Z"
    }
  }
}
```

แสดงการลบ Flag diabetes จากครั้งก่อน การเปลี่ยนเวลา และการอยู่ร่วมกันของ no-special กับ system unsure โดยไม่ส่ง `hasUnsureFlag` จาก client

## 6. Operation: อ่านผลและสถานะในโปรไฟล์

### อ่านผลของผู้สูงอายุหนึ่งคน

```graphql
query ReadAssessment($careRecipientId: ID!) {
  careRecipientAssessment(careRecipientId: $careRecipientId) {
    careRecipientId
    answers { code value }
    adlTotalScore
    unsureCount
    flags
    noSpecialConditions
    hasUnsureFlag
    dementiaSevere
    assessedAt
  }
}
```

Variables:

```json
{"careRecipientId":"22222222-2222-4222-8222-222222222222"}
```

เมื่อมีสิทธิ์และมีผลแล้ว response (HTTP 200) ใช้ object เดียวกับผล submit ล่าสุด เปลี่ยนชื่อ root field เป็น `careRecipientAssessment` ตัวอย่างเลือก fields บางส่วน:

```graphql
query ReadAssessmentSummary($careRecipientId: ID!) {
  careRecipientAssessment(careRecipientId: $careRecipientId) {
    careRecipientId adlTotalScore unsureCount flags
    noSpecialConditions hasUnsureFlag dementiaSevere assessedAt
  }
}
```

```json
{
  "data": {
    "careRecipientAssessment": {
      "careRecipientId": "22222222-2222-4222-8222-222222222222",
      "adlTotalScore": 9,
      "unsureCount": 3,
      "flags": [],
      "noSpecialConditions": true,
      "hasUnsureFlag": true,
      "dementiaSevere": null,
      "assessedAt": "2026-10-17T04:00:00.000Z"
    }
  }
}
```

เมื่อมีสิทธิ์แต่ยังไม่มีผล response (HTTP 200) สำหรับ query ใดข้างต้น:

```json
{"data":{"careRecipientAssessment":null}}
```

**null โดยไม่มี errors หมายถึง “มีสิทธิ์และยังไม่มีแบบประเมิน” เท่านั้น** หากไม่มีสิทธิ์ต้องมี error ตาม §7–8 แม้ nullable field จะเป็น null ด้วยก็ตาม FE ต้องตรวจ errors ก่อนตีความ data

### `hasAssessment` ในโปรไฟล์ส่วนตัว (REST เดิม)

Request: `GET /api/v1/patient/care-recipients` พร้อม bearer token ของ role PATIENT

Response (HTTP 200; ตัวอย่างโปรไฟล์ที่ยังไม่มีรายละเอียดสุขภาพอื่น):

```json
[
  {
    "id":"22222222-2222-4222-8222-222222222222",
    "name":"ผู้สูงอายุตัวอย่าง",
    "patientId":"user-example",
    "isSelf":false,
    "hasAssessment":true
  },
  {
    "id":"33333333-3333-4333-8333-333333333333",
    "name":"ผู้สูงอายุตัวอย่าง 2",
    "patientId":"user-example",
    "isSelf":false,
    "hasAssessment":false
  }
]
```

เพิ่ม field เดียวกันใน response ของ POST/PUT โปรไฟล์เดิมเมื่อคืน `CareRecipientResponse` โดยไม่เปลี่ยน request เดิม และไม่แนบ object ผลประเมิน

### `hasAssessment` ในโปรไฟล์กลุ่ม (GraphQL เดิม + field ใหม่)

```graphql
query GroupProfiles($groupId: ID!) {
  groupCareRecipients(groupId: $groupId) {
    id name ownerUserId hasAssessment
  }
}
```

Variables:

```json
{"groupId":"11111111-1111-4111-8111-111111111111"}
```

Response (HTTP 200):

```json
{
  "data": {
    "groupCareRecipients": [
      {
        "id":"22222222-2222-4222-8222-222222222222",
        "name":"ผู้สูงอายุตัวอย่าง",
        "ownerUserId":"user-example",
        "hasAssessment":true
      }
    ]
  }
}
```

`hasAssessment = มีแถวผลประเมินสมบูรณ์ที่ commit แล้วของ careRecipientId นี้` ไม่ใช้คะแนน > 0, จำนวน Flags, `hasProfile` หรือการกรอก onboarding แทน ผลที่ทั้ง 10 ข้อเป็น null ยังเป็นแบบประเมินสมบูรณ์: คะแนน 0, unsure 10, flag true, hasAssessment true

FE ใช้ false เพื่อพาผู้ใช้เดิมไปประเมินตาม AC10 หลัง submit สำเร็จต้อง refetch/update cache ของโปรไฟล์ทั้งสองทาง BE ตรวจ gate ซ้ำเสมอ ไม่เชื่อ `hasAssessment` จาก client

## 7. สิทธิ์และการไม่เปิดเผยข้อมูลสุขภาพ

**ส่วนนี้เป็นข้อเสนอเพื่อรีวิว D2 ยังไม่ใช่มติสิทธิ์ของ story** แยกความสัมพันธ์กับผู้สูงอายุออกจาก role ระบบ: repo มี PATIENT=1, CAREGIVER=2, ADMIN=3, SUPER_ADMIN=4 และกลุ่มครอบครัวรองรับผู้ใช้ทุก role อยู่แล้ว

| บริบทผู้เรียก | submit | อ่านผลเต็ม §4 | `hasAssessment` |
| --- | --- | --- | --- |
| เจ้าของโปรไฟล์ (`care_recipients.patientId = actor.id`) ที่ยังไม่ถูกลบ | ได้ | ได้ | ได้ในโปรไฟล์ที่ตนมีสิทธิ์ |
| สมาชิก ACTIVE กลุ่มที่โปรไฟล์ถูกแชร์อยู่ และผ่านเงื่อนไขการเปิดเผยข้อมูลของเจ้าของตามระบบเดิม | ไม่ได้ เว้นแต่เป็นเจ้าของโปรไฟล์ | เสนอให้อ่านได้เพื่อจองแทน; รอ Sammy เคาะ | เสนอให้ได้พร้อมรายการโปรไฟล์ที่มีสิทธิ์เห็น |
| ผู้ดูแลในฐานะผู้รับงาน ไม่ได้เป็นเจ้าของ/ญาติที่มีสิทธิ์ข้างต้น | ไม่ได้ | ยังไม่เปิดใน draft; รอระบุ fields และสถานะ booking ที่อนุญาต | ไม่ได้รับจากช่องทางสำหรับผู้ดูแล |
| ADMIN / SUPER_ADMIN ในฐานะงานแอดมิน ไม่มีความสัมพันธ์กับโปรไฟล์ | ไม่ได้ | ยังไม่เปิดใน draft; รอระบุ fields และขอบเขตงาน | ไม่ได้รับจากช่องทางแอดมิน |
| role CAREGIVER/ADMIN ที่เป็นเจ้าของโปรไฟล์หรือญาติในกลุ่มจริง | ใช้สิทธิ์ตามความสัมพันธ์สองแถวแรก | ใช้สิทธิ์ตามความสัมพันธ์สองแถวแรก | ตามความสัมพันธ์ ไม่ได้สิทธิ์เพราะ role |
| ไม่ login, คนนอก, สมาชิก INACTIVE/ออกจากกลุ่ม, กลุ่มอื่น, โปรไฟล์ลบแล้ว | ไม่ได้ | ไม่ได้ | ไม่ได้รับ |

Field ที่ผู้มีสิทธิ์อ่านเต็มได้รับคือ `careRecipientId`, `answers`, `adlTotalScore`, `unsureCount`, `flags`, `noSpecialConditions`, `hasUnsureFlag`, `dementiaSevere`, `assessedAt` เท่านั้น `assessedBy`, DB assessment `id`, `createdAt`, `updatedAt` ไม่เปิดใน type นี้แก่ทุก role ส่วน `careGroup` รอ contract S09

จนกว่า D2 จะได้มติ **ผู้ดูแลที่รับงานและแอดมินไม่มี field จาก type นี้ผ่านงานดูแล/งานแอดมิน** ห้ามใช้ nullable เพื่อส่งข้อมูลสุขภาพบางส่วนโดยยังไม่มี field matrix ที่อนุมัติ หากภายหลังอนุญาตข้อมูลบางส่วน ให้แยก type/projection ที่มีเฉพาะ fields ที่อนุญาต พร้อม object-level authorization ไม่ทำ non-null fields ของ type เต็มให้คืน null ตาม role จนเกิด null bubbling

- `CareRecipientAssessment` ใช้ได้เฉพาะ private query/mutation ที่ตรวจสิทธิ์ ห้ามแนบใน public user/profile/search/listing types, public endpoint หรือ notification/feed payload
- ห้ามส่งคำตอบ/Flags ผ่าน activity metadata, log payload หรือ error details ใช้รหัส field/ข้อที่ผิดได้เฉพาะหลังยืนยันสิทธิ์
- สมาชิกกลุ่มต้องผ่าน ACTIVE membership, โปรไฟล์อยู่ในกลุ่มนั้นจริง, เงื่อนไข consent เดิม และสถานะเจ้าของที่ระบบเดิมกำหนด การเป็น group owner ไม่ทำให้แก้ผลของเจ้าของอื่นได้เอง
- ผู้เรียกที่ตรวจไม่ผ่าน object access และ ID ที่ไม่มีอยู่/ถูกลบ ใช้ **`ASSESSMENT_ACCESS_DENIED` เหมือนกัน** ข้อความเดียวกัน `ไม่สามารถเข้าถึงข้อมูลแบบประเมินนี้ได้`; ไม่มี `hasAssessment`, วันที่, คะแนน, รหัสข้อที่ขาด หรือข้อมูลว่ามีโปรไฟล์จริงใน error
- ตรวจ access ก่อน lookup assessment และก่อนคืน domain validation metadata ของ submit สำหรับผู้ไม่มีสิทธิ์ ไม่ใช้ `ASSESSMENT_REQUIRED` หรือ success-null เพื่อบอกสถานะของคนอื่น
- โปรไฟล์ REST เดิมมีพฤติกรรม 403/404 แยกกันอยู่; การ์ดนี้ไม่อ้างว่าได้แก้ช่องทางเดิมแล้ว แต่ operation assessment ใหม่ต้องใช้ข้อกำหนดไม่เปิดเผยข้างต้น

## 8. Error contract

### HTTP กับ GraphQL

ตามโจทย์ฉบับนี้ business validation เป็น **422** แม้คอมเมนต์ ADL วันที่ 9 ต.ค. เดิมเขียน 400: ให้ FE/BE รับรองการใช้ 422 ใน D4 เพื่อปิดข้อขัดแย้งโดยชัดแจ้ง

- REST booking: HTTP **422** และ JSON มี `statusCode`, `code`, `message`
- GraphQL: เสนอให้ execution error ใช้ HTTP **200** ตาม GraphQL response โดยให้ `errors[].extensions.code` เป็น domain code และ `errors[].extensions.statusCode = 422` เป็นสถานะเชิงธุรกิจ; ไม่สัญญาว่า GraphQL transport จะตอบ HTTP 422
- ใช้ `extensions.statusCode` เป็น field สถานะของ contract นี้ ไม่ตั้ง `extensions.http.status` เพื่อบังคับ HTTP โดยปริยาย ต้องให้ BE/FE รับรองและตรวจ integration จริง เพราะ repo ยังไม่มี assessment error mapper
- JSON เสีย, GraphQL parse/schema validation หรือ variable coercion เช่น `value: 1.5`, `value: "2"`, boolean/string ผิดชนิด, `flags: [null]`, ขาด non-null field: ถูกปฏิเสธก่อน business validation โดยทั่วไป HTTP 400 ใช้ GraphQL framework code เดิม (`GRAPHQL_PARSE_FAILED`, `GRAPHQL_VALIDATION_FAILED`, `BAD_USER_INPUT` ตามชนิด) ไม่รับประกันว่าจะเป็น `ASSESSMENT_*`
- ค่า Int ถูกชนิดแต่เกินช่วง เช่น grooming=2 เป็น domain validation 422 `ASSESSMENT_ANSWER_INVALID`

| code | สถานะเชิงธุรกิจ | ใช้เมื่อ | Metadata หลังผ่านสิทธิ์ |
| --- | --- | --- | --- |
| `ASSESSMENT_INCOMPLETE` | 422 | ข้อ ADL/`value` หาย; หรือข้อบังคับตาม §3 ยังไม่ยืนยัน | `missingAnswerCodes` และ/หรือ `fields` |
| `ASSESSMENT_ANSWER_INVALID` | 422 | code นอกรายการ/ตัวพิมพ์ผิด, code ซ้ำ, คะแนนเกินช่วง | `invalidAnswerCodes`, `duplicateAnswerCodes` ตามกรณี |
| `ASSESSMENT_FLAG_INVALID` | 422 | รหัส Flags นอกรายการ รวม unsure; หรือ Flag ซ้ำ | `fields: ["flags"]` |
| `ASSESSMENT_FLAGS_CONFLICT` | 422 | noSpecialConditions พร้อม Flag ญาติ หรือ severity ไม่สัมพันธ์กับ dementia | `fields` ของส่วนที่ขัดกัน |
| `ASSESSMENT_REQUIRED` | 422 | ผ่านด่านสิทธิ์จองแล้ว แต่ผู้สูงอายุเป้าหมายไม่มี assessment | ไม่คืนคำตอบ/Flags; FE รู้ผู้สูงอายุที่ตนเลือกอยู่แล้ว |
| `ASSESSMENT_ACCESS_DENIED` (เสนอใหม่) | 403 | ไม่มีสิทธิ์ต่อโปรไฟล์, ID ไม่มีจริง/ถูกลบ, ID string ไม่เป็น UUID | ไม่มี metadata ของผู้สูงอายุ |
| `UNAUTHENTICATED` (ใช้ framework) | 401 | ไม่มี/หมดอายุ token | ไม่มีข้อมูลผู้สูงอายุ; รูปทรง guard จริงต้องตรวจใน PYG-609 |
| `INTERNAL_SERVER_ERROR` (ใช้ framework) | 500 | persistence หรือระบบขัดข้อง | ข้อความทั่วไป ไม่คืน DB error/สุขภาพ; ผลเดิมไม่เปลี่ยน |

ลำดับกรณีหลายข้อผิดใน request เดียวที่ผ่าน GraphQL coercion แล้ว: **auth → object access → answer code ไม่ถูกต้อง/ซ้ำ → ข้อหรือ value หาย → ช่วงคะแนน → Flag ไม่ถูกต้อง/ซ้ำ → Flags conflict → ข้อบังคับอื่นของ Flags → เขียนข้อมูล** ตัวอย่าง unknown code แทน feeding ให้ ANSWER_INVALID ก่อน INCOMPLETE เพื่อไม่ให้แต่ละฝั่งเดาผลต่างกัน

ตัวอย่าง incomplete ใช้ mutation และ variables ใน §5 แต่ **ลบ entry bladder ออก**:

```json
{
  "data": null,
  "errors": [{
    "message":"กรุณาตอบแบบประเมิน ADL ให้ครบทุกข้อ",
    "path":["submitCareRecipientAssessment"],
    "extensions":{
      "code":"ASSESSMENT_INCOMPLETE",
      "statusCode":422,
      "missingAnswerCodes":["bladder"]
    }
  }]
}
```

`data: null` เพราะ mutation root field เป็น non-null; ห้ามทำ success response หรือเขียนส่วนที่ตอบแล้วเมื่อ error

ตัวอย่าง query เดิมของ §6 ด้วย ID ที่ผู้เรียกไม่มีสิทธิ์ (HTTP 200 ในข้อเสนอ GraphQL):

```json
{
  "data":{"careRecipientAssessment":null},
  "errors":[{
    "message":"ไม่สามารถเข้าถึงข้อมูลแบบประเมินนี้ได้",
    "path":["careRecipientAssessment"],
    "extensions":{"code":"ASSESSMENT_ACCESS_DENIED","statusCode":403}
  }]
}
```

หากเป็น submit ให้ใช้ code/message เดียวกัน และ `data: null`; ห้ามแยก not-found ออกจาก not-authorized ใน assessment operation

## 9. Booking gate: ไม่มีแบบประเมิน

เพิ่ม gate ให้ทั้ง REST `POST /api/v1/bookings` และ GraphQL `createBookingOnBehalf` หลังตรวจ auth/onboarding/สิทธิ์โปรไฟล์และ consent ตามเดิมแล้ว แต่ก่อนเขียน booking, profile ที่สร้างจาก booking, payment, QR, tasks, activity หรือส่ง event ใด ๆ

- ตรวจจาก DB ของ **careRecipientId ที่ booking จะผูกจริง** ไม่ใช่ผู้จอง, memberUserId ตรง ๆ หรือคะแนนที่ client ส่ง
- ถ้าไม่มีผลสมบูรณ์ → `ASSESSMENT_REQUIRED`; ไม่สร้างข้อมูลบางส่วนและไม่เรียกชำระเงิน
- ถ้ามีผล ให้ทำ booking ตาม contract เดิม; S08 ไม่เพิ่ม assessment ทั้งก้อนใน BookingSummary/BookingRest
- ต้องกันเส้นทางเก่าที่ไม่ส่ง careRecipientId ด้วย: ห้าม bypass โดยกรอก patientName/memberDetails/patientProfile แทน ต้อง resolve เป้าหมายที่มีสิทธิ์ก่อน หรือปฏิเสธตามกติกา D6
- Error สิทธิ์ของ booking เดิม เช่น `NOT_A_MEMBER`, `RECIPIENT_NOT_IN_GROUP`, `CONSENT_WITHDRAWN`, `ONBOARDING_REQUIRED` ยังมาก่อน assessment gate ตามบริบท ห้ามตอบ ASSESSMENT_REQUIRED เพื่อเปิดเผยสถานะคนที่ยังไม่มีสิทธิ์

### GraphQL request/response เมื่อไม่เคยประเมิน

```graphql
mutation BookOnBehalf($input: CreateBookingOnBehalfInput!) {
  createBookingOnBehalf(input: $input) { id status }
}
```

Variables (สมมติผ่านสิทธิ์/consent และเงื่อนไขเดิมแล้ว แต่ผู้สูงอายุนี้ไม่มี assessment):

```json
{
  "input":{
    "groupId":"11111111-1111-4111-8111-111111111111",
    "careRecipientId":"33333333-3333-4333-8333-333333333333",
    "bookingDate":"2026-10-20",
    "startTime":"09:00",
    "endTime":"13:00",
    "serviceType":"elderly_care",
    "tasks":["อาบน้ำ"],
    "serviceLocations":["บ้าน"],
    "locationAddress":"ที่อยู่ตัวอย่าง"
  }
}
```

Response (HTTP 200):

```json
{
  "data":null,
  "errors":[{
    "message":"กรุณาทำแบบประเมิน ADL และเงื่อนไขพิเศษของผู้สูงอายุให้ครบก่อนจอง",
    "path":["createBookingOnBehalf"],
    "extensions":{"code":"ASSESSMENT_REQUIRED","statusCode":422}
  }]
}
```

### REST request/response เมื่อไม่เคยประเมิน

`POST /api/v1/bookings` พร้อม bearer token ของ PATIENT; body:

```json
{
  "careRecipientId":"33333333-3333-4333-8333-333333333333",
  "bookingDate":"2026-10-20",
  "startTime":"09:00",
  "endTime":"13:00",
  "serviceType":"elderly_care",
  "tasks":["อาบน้ำ"],
  "serviceLocations":["บ้าน"],
  "locationAddress":"ที่อยู่ตัวอย่าง"
}
```

Response (HTTP **422**):

```json
{
  "statusCode":422,
  "code":"ASSESSMENT_REQUIRED",
  "message":"กรุณาทำแบบประเมิน ADL และเงื่อนไขพิเศษของผู้สูงอายุให้ครบก่อนจอง"
}
```

FE เก็บฟอร์มจองไว้ พาไปแบบประเมินของเป้าหมาย เมื่อบันทึกสำเร็จ refetch สถานะแล้วให้กลับมายืนยันจอง ห้ามแสดงสำเร็จหรือส่งจองซ้ำอัตโนมัติโดยไม่มีการจัดการคำขอซ้ำตาม flow จองเดิม

## 10. รายการข้อและตัวเลือกอยู่ที่ใคร

**รอ Sammy + BE/FE เคาะ D3**: ชุดรหัสและค่าคะแนนของ v1 คงที่ตาม §2 ไม่ว่าฝั่งใดเก็บรายการข้อความ

- ถ้า FE เก็บรายการ: ไม่มี catalog query ใน v1; BE ยังต้อง validate allowlist ชุดเดียวกันเอง ห้ามเชื่อข้อ/ช่วงคะแนนจาก client
- ถ้า BE เก็บรายการ: เพิ่ม `careRecipientAssessmentDefinition` ตามข้อเสนอด้านล่างในการ์ดนี้ก่อน freeze contract โดยให้ FE แสดงข้อความ TH/EN ที่ยืนยันแล้ว ข้อมูลนี้เป็นข้อมูลอ้างอิงไม่มีสุขภาพรายบุคคล เสนอให้ผู้ login ทุก role อ่านได้

SDL ทางเลือก **เฉพาะเมื่อเลือก BE เป็นเจ้าของรายการ**:

```graphql
type AssessmentDefinitionQuestion {
  code: String!
  allowedScores: [Int!]!
  allowsUnsure: Boolean!
}

type AssessmentDefinitionFlag {
  code: String!
  labelTh: String!
  labelEn: String!
}

type CareRecipientAssessmentDefinition {
  version: String!
  questions: [AssessmentDefinitionQuestion!]!
  flags: [AssessmentDefinitionFlag!]!
  unsureLabelTh: String!
  unsureLabelEn: String!
  unsureThreshold: Int!
}

extend type Query {
  careRecipientAssessmentDefinition: CareRecipientAssessmentDefinition!
}
```

schema ทางเลือกนี้ระบุค่าตัวเลือกที่รับได้ แต่ **ยังไม่พอแทนแบบฟอร์มที่มีคำอธิบายรายคะแนน** เมื่อ D1 ได้ข้อความจริง ต้องเพิ่ม question labels และ option objects `{ value, labelTh, labelEn }` ให้ครบก่อนรับรอง query นี้ ไม่ใช้ label สมมติแทนข้อความอาจารย์

ตัวอย่าง request ของ catalog metadata (conditional):

```graphql
query AssessmentDefinition {
  careRecipientAssessmentDefinition {
    version
    questions { code allowedScores allowsUnsure }
    unsureLabelTh unsureLabelEn unsureThreshold
  }
}
```

Response (HTTP 200; version เป็นชื่อเสนอของ catalog):

```json
{
  "data":{
    "careRecipientAssessmentDefinition":{
      "version":"s08-v1",
      "questions":[
        {"code":"feeding","allowedScores":[0,1,2],"allowsUnsure":true},
        {"code":"grooming","allowedScores":[0,1],"allowsUnsure":true},
        {"code":"transfers","allowedScores":[0,1,2,3],"allowsUnsure":true},
        {"code":"toilet_use","allowedScores":[0,1,2],"allowsUnsure":true},
        {"code":"mobility","allowedScores":[0,1,2,3],"allowsUnsure":true},
        {"code":"dressing","allowedScores":[0,1,2],"allowsUnsure":true},
        {"code":"stairs","allowedScores":[0,1,2],"allowsUnsure":true},
        {"code":"bathing","allowedScores":[0,1],"allowsUnsure":true},
        {"code":"bowels","allowedScores":[0,1,2],"allowsUnsure":true},
        {"code":"bladder","allowedScores":[0,1,2],"allowsUnsure":true}
      ],
      "unsureLabelTh":"ไม่แน่ใจ",
      "unsureLabelEn":"Not sure",
      "unsureThreshold":3
    }
  }
}
```

หากเลือก query นี้: ไม่ต้องส่ง variables; ไม่มี token ใช้ auth guard เดิม, ระบบขัดข้องใช้ framework error เดิม ไม่มี ASSESSMENT_REQUIRED เพราะไม่ได้อ่านผลรายบุคคล `version` เป็นเวอร์ชันนิยามรายการ ไม่ใช่ revision ของผลประเมิน

## 11. Compatibility, acceptance และจุดส่งต่อ

- เพิ่ม fields/types/operations เท่านั้น ไม่ลบ/เปลี่ยนชนิด/เปลี่ยน nullability ของ field เดิม ไม่เพิ่ม required argument ใน operation เดิม
- GraphQL client เก่าที่ยังไม่เลือก `hasAssessment` ได้ผลแบบเดิม REST client ต้องรับ field เพิ่มใน response ได้; FE รุ่นใหม่ deploy หลัง BE ที่รองรับ fields ใหม่ มิฉะนั้น GraphQL validation จะล้ม
- `hasAssessment: Boolean!` ต้อง resolve ได้ทั้ง true/false ในทุก path ที่คืนโปรไฟล์ type นั้น ไม่ปล่อย undefined จนทั้ง list ล้ม
- การเปิด ASSESSMENT_REQUIRED เป็น behavioral change โดยตั้งใจ แม้ schema จองเดิมไม่เปลี่ยน ต้องให้ FE มีเส้นทางประเมินก่อนเปิด gate; การเพิ่ม field อย่างเดียวไม่ได้ทำให้ client เก่ารับ error ใหม่ได้อัตโนมัติ
- AC1: ครบ 10 ข้อ; AC2: คะแนนจาก BE; AC3/4/6: Flags และข้อขัดแย้ง; AC5: unsure ที่ BE ตั้ง; AC8: แทนทั้งชุดและเปลี่ยน assessedAt; AC9: gate จอง; AC10: hasAssessment ในโปรไฟล์เดิม

### ตัวอย่างตรวจรับสำหรับ PYG-609 / PYG-610

| กรณี | ผลที่ต้องได้ |
| --- | --- |
| ค่าสูงสุดครบทุกข้อ | total 20, unsure 0, system flag false |
| ค่า 0 ครบทุกข้อ | total 0, unsure 0, system flag false; hasAssessment true |
| null ครบทุกข้อ | total 0, unsure 10, system flag true; hasAssessment true |
| ตัวอย่างยืนยัน §2 | total 10, unsure 2, system flag false |
| เปลี่ยน dressing จาก 1 เป็น null ในตัวอย่าง | total 9, unsure 3, system flag true |
| แก้กลับจาก unsure 3 เป็น 2 | system flag กลับ false |
| feeding หาย หรือ `{ "code":"feeding" }` | INCOMPLETE; ผลเก่าไม่เปลี่ยน |
| feeding=null โดย entry ยังอยู่ | เป็นคำตอบที่รับได้; ไม่ใช่ incomplete |
| unknown/ตัวพิมพ์ผิด/รหัสซ้ำ | ANSWER_INVALID |
| grooming=2 หรือ transfers=4 หรือ feeding=-1 | ANSWER_INVALID; ส่วน float/string ผิดชนิดถูก GraphQL coercion ปฏิเสธ |
| flags มี unsure หรือค่าแปลภาษา หรือซ้ำ | FLAG_INVALID |
| noSpecialConditions=true พร้อม oxygen | FLAGS_CONFLICT |
| noSpecialConditions=true กับ unsure >=3 | รับ; flags=[] และ hasUnsureFlag=true |
| dementiaSevere=true/false โดยไม่มี dementia | FLAGS_CONFLICT |
| มี dementia แต่ไม่มี severity | INCOMPLETE ตามข้อเสนอ D4 |
| แก้แล้วไม่ส่ง Flag เดิมกลับมา | Flag เดิมถูกลบ ไม่ merge |
| ไม่มีสิทธิ์: ID จริง/ID ไม่มี/soft-deleted | ACCESS_DENIED รูปทรงเดียวกัน; ไม่เผย assessment status |
| อ่านโปรไฟล์ที่มีสิทธิ์และไม่เคยประเมิน | hasAssessment=false และ query=null ไม่มี errors |
| จองไม่มี assessment ผ่าน REST/GraphQL/legacy member-only | REQUIRED ตามช่องทาง; ไม่เกิด side effect; member-only ต้องปิด D6 ก่อน |
| persistence fail ระหว่าง save | rollback ทั้งคำตอบ/คะแนน/Flags/เวลา ไม่คืน success |

### ประเด็นรอเคาะและผู้รับผิดชอบ

| ID | เรื่อง | ข้อเสนอ/สิ่งที่รอ | รอใคร |
| --- | --- | --- | --- |
| D1 | ข้อความคำถาม/ตัวเลือกรายคะแนน ADL | ขอรายการอาจารย์ยืนยัน TH/EN; key/ช่วงคะแนน/null ปิดแล้ว | Sammy / เจ้าของ S08 ประสานอาจารย์ |
| D2 | สิทธิ์เห็นสุขภาพ | รับรอง matrix §7 โดยระบุ field ต่อ role และสถานะงาน; draft ไม่เปิดข้อมูลให้ผู้ดูแลที่รับงาน/แอดมิน | Sammy / เจ้าของ S08 พร้อม BE และ FE |
| D3 | FE หรือ BE เก็บรายการข้อ | เลือกหนึ่งทาง; ถ้า BE ให้เติม labels/options ตาม D1 และรับรอง query §10 | Sammy + เจ้าของ PYG-609 / PYG-610 |
| D4 | validation/error รายละเอียด | รับรอง list input, 422 domain + GraphQL HTTP 200, omitted vs null, severity, flags=[]/false, duplicate policy และ code ACCESS_DENIED | เจ้าของ PYG-609 / PYG-610; Sammy เคาะข้อธุรกิจ |
| D5 | draft ตาม E1 | เสนอ v1 ไม่เก็บ draft ตาม migration PYG-608; ถ้าต้องเก็บ เพิ่ม operation แยก ไม่ใช้ submit ผลสมบูรณ์ | Sammy / เจ้าของ S08 |
| D6 | booking ที่ยังไม่มี careRecipientId | ปัจจุบัน REST จองเอง/บันทึกโปรไฟล์ระหว่างจอง และ GraphQL member-only อาจสร้าง/คัดลอกโปรไฟล์ใน transaction จอง ผลประเมินผูกกับ profile ID จึงห้ามตรวจ assessment ของใบต้นทางแล้วอ้างว่าผ่านสำหรับใบใหม่ ต้องตกลงการเตรียมโปรไฟล์ก่อนประเมิน/คืน ID ให้ FE และผู้มีสิทธิ์บันทึกก่อนเปิด gate; ไม่สร้าง assessment ปลอมหรือ copy สุขภาพข้ามใบเงียบ ๆ | Sammy + เจ้าของ PYG-609 / PYG-610 และเจ้าของ flow จอง |

### Review / publication / handoff checklist

- [x] เขียน draft พร้อมตัวอย่าง operation หลักและเทียบ schema จริงใน checkout
- [x] รหัส ADL และ Flags ตรงกับมติ/ภาพที่ผู้ใช้ส่งมา; ไม่เปลี่ยนรหัสกติกา S16/S17
- [x] ปิดข้อค้างคะแนนไม่แน่ใจด้วยมติ Sammy 9 ต.ค.: null=0 และ threshold 3
- [ ] D1–D6 ได้ข้อสรุปหรือระบุผู้รับผิดชอบพร้อมยืนยันขอบเขตที่ยังรอ
- [ ] เจ้าของ BE PYG-609 รีวิวและรับ contract (ยังไม่มีหลักฐานตอบรับ)
- [ ] เจ้าของ FE PYG-610 รีวิวและรับ contract (ยังไม่มีหลักฐานตอบรับ)
- [ ] นำฉบับที่รับรองแล้วลง Confluence หรือแนบในการ์ด API/การ์ดแม่; ไฟล์นี้เป็นต้นฉบับสำหรับแนบ ยังไม่ได้เผยแพร่ภายนอก
- [ ] เมื่อ contract นิ่ง แจ้งเจ้าของ S09 PYG-612 (BE PYG-614), S16 PYG-569 และ S17 PYG-570 พร้อมลิงก์ฉบับที่รับรอง; ยังไม่ส่งแจ้งระหว่างเป็น draft

ผู้รับ handoff ต้องทราบ: ADL ใช้ exact codes, null เก็บตามจริงแต่คิดคะแนน/ทักษะเป็น 0, system unsure แยกจาก flags, severe เป็น variant ของ dementia, `assessedAt` เปลี่ยนเมื่อประเมินใหม่, `careGroup` ต้องไม่ค้างหลังแก้คะแนน และ assessment API ไม่เปิดเผยสุขภาพผ่าน public types

### ผลตรวจเอกสาร

ตรวจ parse JSON ครบ 18 ตัวอย่าง, ตรวจ GraphQL operation 6 ชุดกับ schema ปัจจุบันที่รวม SDL เสนอเพิ่มในเอกสาร (รวม catalog ทางเลือก), ตรวจชนิด variables ของ submit และตรวจช่วงคะแนน/คะแนนรวม/unsure ของ payload สร้างและแก้ไขทั้ง request/response แล้วผ่าน ตรวจ catalog ให้ตรงช่วงคะแนนครบ 10 ข้อแล้วผ่าน

ผลนี้ยืนยันความสอดคล้องของเอกสารและตัวอย่างเท่านั้น ไม่ใช่ผลทดสอบ API จริง เพราะยังไม่มี implementation ของ assessment operations และไม่ใช่หลักฐาน FE/BE sign-off

## 12. แหล่งตรวจใน repository

- `src/schema.gql`: ชื่อ input/type/query/booking mutation ที่มีอยู่
- `src/app.module.ts`: Apollo code-first config; ไม่มี assessment-specific error mapper
- `src/family-group/entities/care-recipient.entity.ts`, `group-booking-recipient.entity.ts`: profile และ member-only flow
- `src/family-group/family-booking.resolver.ts`, `family-group.service.ts`, `family-group.errors.ts`: สิทธิ์กลุ่ม การซ่อนโปรไฟล์ตาม consent และ GraphQL error taxonomy
- `src/patient/care-recipients.controller.ts`, `care-recipients.service.ts`: REST profile และ owner-only CRUD เดิม
- `src/booking/booking.controller.ts`, `booking.service.ts`, `dto/create-booking.dto.ts`: REST/GraphQL booking entry points และ flow ที่อาจสร้างโปรไฟล์
- `src/consent/consent.errors.ts`, `src/identity/auth/onboarding-gate.ts`: รูปทรง error GraphQL/REST ที่ต้องแยกกัน
- `src/common/constants/roles.constant.ts`, `src/main.ts`: role IDs และ validation พื้นฐาน
- `prisma/schema.prisma`: model ผลประเมินและ careGroup
- `prisma/migrations/20261007030000_pyg563_care_recipient_assessments/migration.sql`: unique/ไม่มี draft/RLS/soft-delete caveat
- `prisma/migrations/20261008070000_pyg569_seed_flag_level_rules/migration.sql`: Flags และ system unsure mapping
- `prisma/migrations/20261009000000_pyg570_seed_required_skills/migration.sql`: exact ADL keys และกติกาทักษะ 7 ข้อ
- FE `payung-web/src/graphql/familyGroup.ts`, `src/pages/booking/steps/BookingStepPatient.tsx`, `src/lib/bookingSubmitError.ts`: profile queries/REST list และการอ่าน booking errors ที่ต้องรองรับ contract ใหม่
