# S09 · Contract กลุ่มผู้สูงอายุใน API

การ์ดแม่ **PYG-564** · BE **PYG-614** · เกี่ยวข้องกับ S08 **PYG-607 / PYG-609**, DB **PYG-613** และ S14 **PYG-567**

วันที่ 17 ต.ค. 2026 (Asia/Bangkok) · **Draft v0.2 สำหรับรีวิว**

เอกสารนี้เป็น contract สำหรับ PYG-614; implementation อยู่ใน branch codex/pyg-614-care-group ที่ต่อจาก S08 ยังไม่ถือว่าเจ้าของ BE/contract S08 รับรองแล้ว และยังไม่ได้ deploy

## 1. ข้อสรุปที่เสนอ

1. API ใช้ enum `ElderCareGroup` สามค่า: `SOCIAL`, `HOMEBOUND`, `BEDRIDDEN` ทั้ง GraphQL และ REST
2. เพิ่ม `careGroup: ElderCareGroup` ที่ root ของโปรไฟล์ผู้สูงอายุ เป็น **nullable** และแยกจากข้อมูลเดิม `details.supportLevel` / `mobility_level`
3. โปรไฟล์ที่มีสิทธิ์อ่านและยังไม่มีแบบประเมินสมบูรณ์ คืน `careGroup: null`; ห้ามใช้ null เพื่อซ่อนว่าผู้เรียกไม่มีสิทธิ์
4. **ให้ส่งกลุ่มใหม่กลับทันทีหลังบันทึกแบบประเมิน**: เพิ่ม `CareRecipientAssessment.careGroup: ElderCareGroup!` ทั้ง mutation บันทึกและ query อ่านผลของ S08 โดยมีเงื่อนไขเปิดใช้ใน §6
5. ไม่เพิ่ม input, operation หรือ error code ใหม่ กลุ่มคำนวณโดย BE จากผลประเมินล่าสุดเท่านั้น
6. เปิด field ผ่านบริบทญาติที่มีสิทธิ์เท่านั้น ไม่เพิ่มในข้อมูลสำหรับผู้ดูแลที่รับงาน แอดมิน หรือ public types ระหว่างรอมติสิทธิ์/consent

ทั้งหกข้อเป็น contract เสนอให้ PYG-614 และเจ้าของ PYG-607 รับรองก่อนรวม/deploy implementation ไม่ใช่หลักฐาน sign-off

## 2. ค่า enum, ข้อความ และ mapping

| ค่าใน GraphQL / REST JSON | ค่าใน DB | ข้อความไทย | English ที่เสนอ | ช่วงคะแนนที่พบใน migration PYG-613 |
| --- | --- | --- | --- | --- |
| `SOCIAL` | `social` | ติดสังคม | Socially active | 12–20 |
| `HOMEBOUND` | `homebound` | ติดบ้าน | Homebound | 5–11 |
| `BEDRIDDEN` | `bedridden` | ติดเตียง | Bedridden | 0–4 |

- JSON ของ GraphQL enum เป็น string ตัวพิมพ์ใหญ่ เช่น `"HOMEBOUND"`; REST ใช้ string ชุดเดียวกัน ไม่ส่ง lowercase ปะปน
- `social_bound`, `home_bound`, `bed_bound` ไม่ใช่รหัสของ contract นี้ และไม่ใช่ค่าที่ S14 ใช้ในตารางจับคู่
- ข้อความอังกฤษเป็น **ข้อเสนอรอ Sammy/เจ้าของ story ยืนยัน** ไม่ได้อ้างว่าอาจารย์อนุมัติแล้ว
- ช่วงคะแนนในตารางถอดจาก migration ที่อยู่ใน repo เพื่อให้ตรวจความสอดคล้อง ไม่เปลี่ยนเกณฑ์หรือเสนอเกณฑ์ทางคลินิกใหม่ เจ้าของ PYG-614 ต้องยืนยันว่าตรงกับ S09 ฉบับที่รับรองก่อน sign-off
- ไม่แน่ใจของ S08 เก็บ null และคิดคะแนน 0 ตามมติ Sammy 9 ต.ค. 2026 ดังนั้นคำตอบครบแต่ไม่แน่ใจทุกข้อได้คะแนน 0 และเป็น `BEDRIDDEN` ไม่ใช่ `careGroup: null`

## 3. Type และความหมายของค่าว่าง

SDL เสนอเพิ่มจาก schema ที่ตรวจใน checkout:

```graphql
enum ElderCareGroup {
  SOCIAL
  HOMEBOUND
  BEDRIDDEN
}

extend type GroupCareRecipient {
  careGroup: ElderCareGroup
}

extend type CareRecipientAssessment {
  careGroup: ElderCareGroup!
}
```

REST ใช้ `CareRecipientResponse` เดิม เพิ่ม property `careGroup` ที่ต้องมีใน JSON ทุก response โดยค่าเป็น `"SOCIAL" | "HOMEBOUND" | "BEDRIDDEN" | null` ไม่ละ property เมื่อไม่มีผลประเมิน

| สถานะ | ค่าในโปรไฟล์ | ค่าเมื่อ query อ่านแบบประเมิน |
| --- | --- | --- |
| มีผลประเมินสมบูรณ์ คะแนน 12–20 | `SOCIAL` | object ผลประเมินมี `careGroup: SOCIAL` |
| มีผลประเมินสมบูรณ์ คะแนน 5–11 | `HOMEBOUND` | object ผลประเมินมี `careGroup: HOMEBOUND` |
| มีผลประเมินสมบูรณ์ คะแนน 0–4 | `BEDRIDDEN` | object ผลประเมินมี `careGroup: BEDRIDDEN` |
| ยังไม่มีผลประเมินสมบูรณ์ | `null` | root `careRecipientAssessment: null` โดยไม่มี errors |
| ไม่มีสิทธิ์อ่านโปรไฟล์/ผล | ไม่ส่งข้อมูลของโปรไฟล์นั้นตามนโยบายเดิม | ตอบ access error เดิม ไม่ใช้ success-null เพื่อบอกสถานะ |

เมื่อ S09 พร้อมใช้งาน `hasAssessment: false` ต้องคู่กับ `careGroup: null`; `hasAssessment: true` ต้องคู่กับหนึ่งในสามกลุ่ม แม้คะแนนรวมเป็น 0

`careGroup` ของโปรไฟล์อ้างอิงแบบประเมินล่าสุดของ **careRecipientId ใบนั้น** ไม่อ้างจากบัญชีผู้จอง ไม่ใช้ profile อื่นของเจ้าของบัญชีเดียวกัน และไม่ดึงจาก `mobility_level`

## 4. Inventory: ทุก operation ที่เกี่ยวข้อง

ตรวจ GraphQL schema และ controller/service จริงที่ commit `370b48bf717e8db4cd716e8b3aadca85b62f6281` บน branch `codex/pyg-609-adl-assessment` ซึ่งเป็นงาน S08 ใน draft PR #125; **ไม่ถือว่า PR นี้ merge หรือ deploy แล้ว**

พบ GraphQL operation ที่คืน `GroupCareRecipient` โดยตรงครบ 3 จุด และไม่พบ type อื่นที่ฝัง `GroupCareRecipient` เป็น field ซ้อนอยู่ โปรไฟล์ส่วนตัวอีก 3 จุดเป็น REST ต้องเพิ่ม field ให้ครบด้วย

### 4.1 โปรไฟล์ผู้สูงอายุ: ต้องเพิ่ม careGroup ครบทุกแถว

| ช่องทาง | Operation เดิม | Type / response | สิ่งที่ต้องคืน |
| --- | --- | --- | --- |
| GraphQL query | `groupCareRecipients(groupId: ID!)` | `[GroupCareRecipient!]!` | careGroup ของแต่ละ profile ID ที่ผู้เรียกมีสิทธิ์เห็น |
| GraphQL mutation | `addGroupCareRecipient(input: AddGroupCareRecipientInput!)` | `GroupCareRecipient!` | `careGroup: null` สำหรับโปรไฟล์ใหม่ที่ยังไม่ประเมิน |
| GraphQL mutation | `updateGroupCareRecipient(input: UpdateGroupCareRecipientInput!)` | `GroupCareRecipient!` | กลุ่มจากผลล่าสุดของใบเดิม ไม่หายหลังแก้ชื่อ/ชื่อเล่น |
| REST | `GET /api/v1/patient/care-recipients` | `CareRecipientResponse[]` | careGroup ของแต่ละโปรไฟล์ที่เป็นของผู้ login |
| REST | `POST /api/v1/patient/care-recipients` | `CareRecipientResponse` | `careGroup: null` สำหรับโปรไฟล์ใหม่ |
| REST | `PUT /api/v1/patient/care-recipients/:id` | `CareRecipientResponse` | กลุ่มจากผลล่าสุด ไม่เปลี่ยนเพราะแก้ details/supportLevel |

ชื่อ/arguments/return type ของ operation เดิมไม่เปลี่ยน GraphQL ส่ง careGroup เมื่อ client เลือก field นี้; REST ส่ง property นี้เสมอ

### 4.2 ผลประเมินของ S08: ต้องเพิ่มพร้อมกันทั้งอ่านและบันทึก

| Operation เดิมจาก PYG-607 / PYG-609 | Type | ข้อเสนอ S09 |
| --- | --- | --- |
| `submitCareRecipientAssessment(input: SubmitCareRecipientAssessmentInput!)` | `CareRecipientAssessment!` | คืน `careGroup: ElderCareGroup!` ที่คำนวณใหม่ในครั้งนั้น |
| `careRecipientAssessment(careRecipientId: ID!)` | `CareRecipientAssessment` | เมื่อมี object ต้องมี careGroup; ถ้าไม่มีผลทั้ง object เป็น null |

การเพิ่ม field ใน type นี้มีผลทั้งสอง operation ห้ามเพิ่มให้เฉพาะ mutation แล้วลืมขาอ่าน ต้องให้เจ้าของ PYG-607 รับทราบ/รับรองส่วนขยายนี้

### 4.3 ตรวจแล้ว: operation/type ที่ไม่เพิ่ม careGroup ใน v1

| จุดที่ตรวจ | เหตุผล / ข้อกำหนด |
| --- | --- |
| `groupBookingRecipients(groupId: ID!): [GroupBookingRecipient!]!` | เป็นรายการ **สมาชิกบัญชี** ไม่ใช่รายการโปรไฟล์; มีคนที่ยังไม่มีโปรไฟล์และ fallback ใช้ใบ is_self ได้ ทั้งยังไม่คืน careRecipientId จึงไม่เพิ่มกลุ่มที่อาจมาจากคนละใบกับ booking โดยปริยาย |
| `removeGroupCareRecipient` | คืน `RemoveGroupCareRecipientResult` ที่มี recipientId/removed เป็นผล unshare ไม่ใช่โปรไฟล์ จึงไม่มี field กลุ่มใน response นี้ |
| REST `DELETE /api/v1/patient/care-recipients/:id` | คืน 204 ไม่มี response body |
| `completeOnboarding(input): User!` และ query/mutation ที่คืน `User` | คืนบัญชี ไม่ใช่โปรไฟล์ care recipient ไม่เพิ่มสุขภาพเข้า User type ที่ถูกใช้หลายบริบท |
| `BookingSummary.patientProfile` และ `CaregiverBookingSummary.patientProfile` | เป็นรายละเอียด snapshot ของ booking ไม่ใช่โปรไฟล์ล่าสุด และตัวหลังเป็น response ฝั่งผู้ดูแล ห้ามแนบ careGroup ผ่าน shared `PatientProfileType` |
| `GroupCareRecipientDetails`, `GroupBookingRecipientDetails`, `PatientProfileInput`, DTO details เดิม | ไม่เพิ่ม careGroup ใน details หรือ input; field ใหม่อยู่ root ของโปรไฟล์ที่ระบุใน §4.1 |
| Public profiles, caregiver search/listing, admin projections, activity/notification payloads | ไม่เพิ่ม careGroup ในการ์ดนี้ |

สำหรับ S14 ให้ใช้ `careRecipientId` ของโปรไฟล์ที่เลือกแล้วอ่านกลุ่มจากช่องทาง §4.1/4.2 ห้ามใช้ `memberUserId`, `hasProfile` หรือกลุ่มของใบ fallback แทน หาก S14 จำเป็นต้องใช้รายการ member shortcut เป็นแหล่งกลุ่ม ต้องตกลงส่วนขยายที่คืน source profile ID และกลุ่มจากใบเดียวกันก่อน ไม่อยู่ใน draft นี้

## 5. สิทธิ์และขอบเขตข้อมูลสุขภาพ

| บริบทผู้เรียก | ได้ careGroup หรือไม่ | เงื่อนไข |
| --- | --- | --- |
| ญาติ/เจ้าของโปรไฟล์ | ได้ | ตรวจความเป็นเจ้าของจากผู้ login กับ patientId ของโปรไฟล์ และโปรไฟล์ไม่ถูกซ่อน |
| ญาติในกลุ่มครอบครัว | ได้ตามสิทธิ์อ่านโปรไฟล์/ผลประเมินเดิม | ผู้เรียกและเจ้าของยัง ACTIVE, profile ถูกแชร์ในกลุ่มนั้น, ผ่านเงื่อนไขการเปิดเผย/consent ตาม S08; ไม่ขยายสิทธิ์เพราะเพิ่ม field |
| ผู้ดูแลในฐานะผู้รับงาน | ยังไม่ได้ | รอ Sammy/เจ้าของ story ระบุ field matrix และเงื่อนไข consent |
| ADMIN/SUPER_ADMIN ในฐานะงานแอดมิน | ยังไม่ได้ | รอมติเดียวกับสิทธิ์เห็นข้อมูลสุขภาพ S08 |
| คนนอกกลุ่ม, สมาชิกออกแล้ว, ไม่ login, ไม่มีสิทธิ์ต่อโปรไฟล์ | ไม่ได้ | ใช้ guard/filter/error เดิม ไม่เปิดเผยว่ามีผลประเมินหรืออยู่กลุ่มใด |

Role ระบบไม่ใช่หลักฐานความสัมพันธ์กับผู้สูงอายุ หากผู้ใช้ role CAREGIVER/ADMIN เป็นญาติที่มีสิทธิ์อยู่จริง การเข้าถึงในบริบทญาติยังต้องผ่านเงื่อนไขเดียวกับญาติอื่นและข้อจำกัดช่องทางเดิม เช่น REST โปรไฟล์ส่วนตัวปัจจุบันเปิดเฉพาะ PATIENT ไม่เปลี่ยน role guard ในการ์ดนี้ การรับงานหรือ role แอดมินอย่างเดียวไม่ทำให้ได้รับ field

ขอบเขต consent ใช้นโยบายที่ S08 รับรองต่อไป **ไม่ถือว่าการอ่านหรือส่ง careGroup เป็นการยินยอมโดยปริยาย** ไม่เพิ่มชนิด consent หรือเขียน user_consents ในการ์ดเอกสารนี้ เรื่องว่าใครเห็นกลุ่มได้เมื่อไรและ consent ฉบับใดยังรอ Sammy/เจ้าของ story ตาม §9

สำหรับผู้ไม่มีสิทธิ์ ห้ามคืน `careGroup: null` พร้อม `hasAssessment` หรือข้อมูลโปรไฟล์เพื่อทำเป็นการปกปิดบางส่วน ต้องคงการปฏิเสธ/กรองโปรไฟล์ตาม contract เดิม เช่น query ผลประเมินใช้ `ASSESSMENT_ACCESS_DENIED`; group query ใช้ guard กลุ่มเดิม การ์ดนี้ไม่สร้างรหัส error ใหม่

## 6. การคำนวณหลัง submit และเงื่อนไขก่อนเปิดใช้

- PYG-614 ต้องทำให้การบันทึกคำตอบ คะแนนรวม unsure/Flags กลุ่มใหม่ และ assessedAt เป็นผลจากคำขอชุดเดียวกันใน transaction เดียว ผลสำเร็จของ submit ต้องคืนกลุ่มหลังบันทึก ไม่ใช่กลุ่มก่อนแก้ไข
- อ่านโปรไฟล์หรือผลประเมินหลัง commit ต้องเห็นกลุ่มใหม่ สอดคล้องกับคะแนนล่าสุด; แก้ชื่อ/ชื่อเล่น/details อย่างเดียวไม่เปลี่ยนกลุ่ม
- ไม่เพิ่ม careGroup ใน `SubmitCareRecipientAssessmentInput`, `Create/UpdateCareRecipientDto`, `Add/UpdateGroupCareRecipientInput`, onboarding input, booking input หรือ input ของ S14 เพื่อให้ client กำหนดสุขภาพเอง การระบุ field ที่ไม่อยู่ใน input ใช้ validation/error เดิม ไม่เพิ่มรหัสใหม่
- S14 ต้องแปลง API enum กลับเป็น DB code ตาม §2 ภายใน BE เมื่อตรวจตาราง `care_group_service_packages` และอ่านกลุ่มจากผลประเมินจริง ไม่เชื่อกลุ่มที่ client อ้าง

### ประเด็นสำคัญ: DB null ระหว่าง rollout ไม่ได้แปลว่าไม่เคยประเมินเสมอไป

schema Prisma มี `care_recipient_assessments.careGroup: String?` และ PYG-609 ยังไม่คำนวณกลุ่ม จึงอาจมี **assessment อยู่แต่ care_group เป็น null** ได้จริงก่อน S09 พร้อม

ข้อเสนอก่อนหน้าที่ให้ fallback คำนวณเมื่ออ่านถูกแทนที่ด้วยข้อกำหนด BE ล่าสุดด้านล่าง

ก่อนให้ FE ใช้ contract ที่ null แปลว่าไม่มีแบบประเมิน และก่อนเพิ่ม `CareRecipientAssessment.careGroup!` ต้องให้ PYG-614 ทำครบดังนี้:

1. คำนวณ/บันทึกกลุ่มทุกครั้งที่ submit สร้างหรือแก้ไข assessment ผ่านทุก writer
2. backfill กลุ่มของผลเดิมจากคะแนนรวมที่ valid และตรวจความสอดคล้อง ไม่มีผลเดิมที่กลุ่มยัง null
3. ตามข้อกำหนด BE ล่าสุด **ห้ามคำนวณกลุ่มซ้ำตอนอ่าน**: ต้อง backfill และตรวจ readiness ก่อนเปิดใช้ API ที่สัญญา careGroup! ถ้ายังพบ assessment ที่กลุ่มว่าง/ผิดรูป ให้หยุด rollout หรือใช้ error ระบบเดิม ไม่แปลงเป็น “ยังไม่มีแบบประเมิน” และไม่ fallback จากคะแนนหรือ mobility_level
4. deploy BE พร้อมก่อน FE เลือก field ใหม่ และทดสอบ S08 submit/read + profile responses ทุกแถวใน §4

ห้ามเพิ่ม non-null field แล้วปล่อย null จากข้อมูลเดิมให้ GraphQL null-bubbling จน mutation/query ล้มหลังข้อมูลถูกบันทึกแล้ว DB nullability ไม่จำเป็นต้องเหมือน GraphQL nullability แต่ BE ต้องรักษาความหมายที่ contract สัญญาไว้ การตั้ง DB NOT NULL เป็นงาน DB/BE แยก ไม่รัน migration ในการ์ดนี้

## 7. ตัวอย่าง requests/responses

ตัวอย่างทั้งหมดเป็น **ผลตาม contract ที่เสนอหลัง PYG-614 ทำเสร็จ** ไม่ใช่หลักฐานว่า endpoint ปัจจุบันมี careGroup แล้ว

### 7.1 GraphQL: โปรไฟล์ครบทั้ง 3 กลุ่มและยังไม่ประเมิน

```graphql
query ElderProfiles($groupId: ID!) {
  groupCareRecipients(groupId: $groupId) {
    id
    name
    hasAssessment
    careGroup
  }
}
```

Variables:

```json
{"groupId":"11111111-1111-4111-8111-111111111111"}
```

Response HTTP 200:

```json
{
  "data": {
    "groupCareRecipients": [
      {"id":"22222222-2222-4222-8222-222222222222","name":"ผู้สูงอายุ A","hasAssessment":true,"careGroup":"SOCIAL"},
      {"id":"33333333-3333-4333-8333-333333333333","name":"ผู้สูงอายุ B","hasAssessment":true,"careGroup":"HOMEBOUND"},
      {"id":"44444444-4444-4444-8444-444444444444","name":"ผู้สูงอายุ C","hasAssessment":true,"careGroup":"BEDRIDDEN"},
      {"id":"55555555-5555-4555-8555-555555555555","name":"ผู้สูงอายุ D","hasAssessment":false,"careGroup":null}
    ]
  }
}
```

### 7.2 GraphQL: สร้างโปรไฟล์และแก้โปรไฟล์เดิม

```graphql
mutation AddElderProfile($input: AddGroupCareRecipientInput!) {
  addGroupCareRecipient(input: $input) { id name hasAssessment careGroup }
}
```

```json
{"input":{"groupId":"11111111-1111-4111-8111-111111111111","name":"ผู้สูงอายุ D"}}
```

```json
{"data":{"addGroupCareRecipient":{"id":"55555555-5555-4555-8555-555555555555","name":"ผู้สูงอายุ D","hasAssessment":false,"careGroup":null}}}
```

ตัวอย่างแยกกัน: แก้ชื่อโปรไฟล์ B ที่ประเมินแล้ว ต้องยังได้กลุ่มเดิม:

```graphql
mutation UpdateElderProfile($input: UpdateGroupCareRecipientInput!) {
  updateGroupCareRecipient(input: $input) { id name hasAssessment careGroup }
}
```

```json
{"input":{"groupId":"11111111-1111-4111-8111-111111111111","recipientId":"33333333-3333-4333-8333-333333333333","name":"ผู้สูงอายุ B ชื่อใหม่"}}
```

```json
{"data":{"updateGroupCareRecipient":{"id":"33333333-3333-4333-8333-333333333333","name":"ผู้สูงอายุ B ชื่อใหม่","hasAssessment":true,"careGroup":"HOMEBOUND"}}}
```

### 7.3 REST: โปรไฟล์ส่วนตัวครบทุกสถานะ

`GET /api/v1/patient/care-recipients` พร้อม bearer token ของ PATIENT ที่เป็นเจ้าของ Response HTTP 200:

```json
[
  {"id":"22222222-2222-4222-8222-222222222222","name":"ผู้สูงอายุ A","patientId":"user-example","isSelf":false,"hasAssessment":true,"careGroup":"SOCIAL"},
  {"id":"33333333-3333-4333-8333-333333333333","name":"ผู้สูงอายุ B","patientId":"user-example","isSelf":false,"hasAssessment":true,"careGroup":"HOMEBOUND"},
  {"id":"44444444-4444-4444-8444-444444444444","name":"ผู้สูงอายุ C","patientId":"user-example","isSelf":false,"hasAssessment":true,"careGroup":"BEDRIDDEN"},
  {"id":"55555555-5555-4555-8555-555555555555","name":"ผู้สูงอายุ D","patientId":"user-example","isSelf":false,"hasAssessment":false,"careGroup":null}
]
```

REST POST body เดิม `{"name":"ผู้สูงอายุ D"}` → HTTP 201 คืน object รูปทรงแถว D ข้างต้น; REST PUT body เดิม `{"name":"ผู้สูงอายุ B ชื่อใหม่"}` ที่ path ของ B → HTTP 200 คืน object ของ B พร้อมชื่อใหม่และ `careGroup: "HOMEBOUND"` ไม่ส่งกลุ่มใน request ทั้งสองกรณี

### 7.4 S08: บันทึกผลใหม่และรับกลุ่มใหม่ใน response เดียวกัน

ตัวอย่าง B เปลี่ยนจาก HOMEBOUND เป็น SOCIAL หลังประเมินใหม่ คะแนน 20:

```graphql
mutation ReassessElder($input: SubmitCareRecipientAssessmentInput!) {
  submitCareRecipientAssessment(input: $input) {
    careRecipientId adlTotalScore unsureCount flags
    noSpecialConditions hasUnsureFlag dementiaSevere assessedAt careGroup
  }
}
```

```json
{
  "input": {
    "careRecipientId":"33333333-3333-4333-8333-333333333333",
    "answers":[
      {"code":"feeding","value":2},
      {"code":"grooming","value":1},
      {"code":"transfers","value":3},
      {"code":"toilet_use","value":2},
      {"code":"mobility","value":3},
      {"code":"dressing","value":2},
      {"code":"stairs","value":2},
      {"code":"bathing","value":1},
      {"code":"bowels","value":2},
      {"code":"bladder","value":2}
    ],
    "flags":[],
    "noSpecialConditions":true
  }
}
```

```json
{
  "data": {
    "submitCareRecipientAssessment": {
      "careRecipientId":"33333333-3333-4333-8333-333333333333",
      "adlTotalScore":20,
      "unsureCount":0,
      "flags":[],
      "noSpecialConditions":true,
      "hasUnsureFlag":false,
      "dementiaSevere":null,
      "assessedAt":"2026-10-17T08:00:00.000Z",
      "careGroup":"SOCIAL"
    }
  }
}
```

### 7.5 S08: อ่านผลหลังบันทึก และกรณียังไม่ประเมิน

```graphql
query ElderAssessmentGroup($careRecipientId: ID!) {
  careRecipientAssessment(careRecipientId: $careRecipientId) {
    careRecipientId adlTotalScore careGroup assessedAt
  }
}
```

Variables ของ B หลังบันทึก:

```json
{"careRecipientId":"33333333-3333-4333-8333-333333333333"}
```

```json
{"data":{"careRecipientAssessment":{"careRecipientId":"33333333-3333-4333-8333-333333333333","adlTotalScore":20,"careGroup":"SOCIAL","assessedAt":"2026-10-17T08:00:00.000Z"}}}
```

ใช้ query เดิมกับ D ที่ยังไม่ประเมินและผู้เรียกมีสิทธิ์:

```json
{"careRecipientId":"55555555-5555-4555-8555-555555555555"}
```

```json
{"data":{"careRecipientAssessment":null}}
```

## 8. ข้อกำหนด FE และ backward compatibility

- Mapping ตัวอักษรไปข้อความเป็นหน้าที่ FE โดยใช้ตาราง §2 ไม่แสดง DB code หรือชื่อ enum ดิบเป็นข้อความหลัก
- `null` แสดง **“ยังไม่มีแบบประเมิน” / “Not assessed yet”** ตามบริบทผู้มีสิทธิ์ ถ้าเป็น error ต้องจัดการ error ก่อนตีความ null
- **ค่าที่ไม่รู้จัก** ให้ fallback **“ไม่ทราบกลุ่ม” / “Unknown care group”** ไม่ crash ไม่เดาเป็น SOCIAL/HOMEBOUND/BEDRIDDEN และไม่แสดงเหมือนผู้ใช้ไม่เคยประเมิน
- ค่าไม่รู้จักหรือ null ต้องไม่ทำให้ S14 เลือกชุดบริการของกลุ่มอื่นโดยปริยาย ให้คงบริบทผู้สูงอายุไว้และจัดการตาม flow ของ S14
- `careGroup` เปลี่ยนหลังประเมินใหม่ FE ต้องอัปเดต/refetch ทั้งผลประเมินและโปรไฟล์ที่ cache ไว้ รวมถึงชุดบริการ S14 ที่อิงกลุ่มเดิม
- เพิ่ม field ฝั่งอ่านเท่านั้น ไม่ลบ/เปลี่ยนชนิด/nullability ของ field เดิม ไม่เปลี่ยน `supportLevel` ที่มาจาก mobility_level และไม่เพิ่ม required argument
- GraphQL client เก่าที่ไม่เลือก careGroup ยังได้ shape เดิม; REST เพิ่ม property โดย client ต้องรับ field เพิ่มได้; FE ใหม่ต้อง deploy หลัง BE รองรับ field
- ไม่ส่ง label เป็น field ใหม่ใน response v1 นี้ และไม่เพิ่ม query สำหรับ label เพราะ mapping คงที่สามค่า; เปลี่ยนรหัส enum ต้องตกลงผู้ใช้ contract ทุกฝั่งก่อน

## 9. Review, ข้อค้าง และการส่งต่อ

| เรื่อง | สิ่งที่รอ | ผู้รับผิดชอบที่ต้องยืนยัน |
| --- | --- | --- |
| ภาษาอังกฤษ | รับรอง Socially active / Homebound / Bedridden รวมข้อความ fallback ที่จะใช้จริง | Sammy / เจ้าของ S09 และเจ้าของ FE ที่ใช้กลุ่ม |
| สิทธิ์/consent | รับรองขอบเขตญาติและการยังไม่เปิดให้ผู้ดูแลที่รับงาน/แอดมิน; ระบุ consent หากต้องเพิ่มใน S08 | Sammy / เจ้าของ S08–S09 |
| Profile operations | รับรอง inventory §4.1 ครบทั้ง REST และ GraphQL และข้อยกเว้น member shortcut §4.3 | เจ้าของ BE PYG-614 |
| การขยาย S08 | รับรอง CareRecipientAssessment.careGroup! ทั้ง submit/read และการคำนวณ/คืนผลใหม่ใน transaction เดียว | เจ้าของ contract PYG-607 และ BE PYG-609/614 |
| Rollout/null | รับรอง backfill + readiness gate โดยไม่คำนวณตอนอ่าน และความพร้อมทุก writer ก่อนเปิด non-null field | เจ้าของ BE PYG-614 ประสาน DB PYG-613 |
| S14 | รับทราบ exact enum/DB mapping, null/unknown handling, ใช้ profile ID จริง และ refresh เมื่อประเมินใหม่ | เจ้าของ PYG-567 หลัง contract นิ่ง |

Checklist ปิดการ์ด:

- [x] มีร่าง contract พร้อมค่า/nullability/สิทธิ์/ตัวอย่าง responses ทั้งสามกลุ่มและยังไม่ประเมิน
- [x] ตรวจชื่อและ inventory ของ operations กับ schema/โค้ดใน checkout จริง
- [ ] เจ้าของ PYG-614 รีวิวและรับ contract
- [ ] เจ้าของ PYG-607 รับทราบ/รับรองส่วนเพิ่มใน type S08
- [ ] เรื่องสิทธิ์และข้อความอังกฤษได้ข้อสรุป หรือเจ้าของการ์ดยอมรับรายการผู้รับผิดชอบที่ระบุว่ารอในตารางข้างต้น
- [ ] นำฉบับรับรองลง Confluence หรือในการ์ดนี้ (ไฟล์นี้เป็นต้นฉบับพร้อมแนบ ยังไม่ได้เผยแพร่ภายนอก)
- [ ] เมื่อ contract นิ่ง แจ้งเจ้าของ S14 PYG-567 พร้อมลิงก์ฉบับรับรอง; ยังไม่อ้างว่าส่งแจ้งแล้วระหว่างเป็น draft

ผลตรวจเอกสาร: GraphQL ตัวอย่าง 5 operations ผ่าน validation กับ schema ปัจจุบันที่รวม SDL ส่วนเสนอเพิ่มในหน่วยความจำ; JSON ตัวอย่าง 13 ชุด parse ผ่าน; ตรวจ inventory โปรไฟล์ GraphQL ได้ครบ 3 operations; ตรวจ nullability และยืนยันว่า inputs เดิมไม่เปลี่ยน ผลนี้เป็นการตรวจความสอดคล้องของเอกสาร ไม่ใช่การทดสอบ implementation ของ PYG-614 หรือหลักฐานรับรอง contract

## 10. แหล่งตรวจสอบ

- `src/schema.gql`: GroupCareRecipient, GroupBookingRecipient, CareRecipientAssessment และ query/mutation ที่เกี่ยวข้อง
- `src/family-group/family-booking.resolver.ts`, `family-group.service.ts`: โปรไฟล์กลุ่ม, member shortcut และ source profile/consent ที่ต่างกัน
- `src/patient/care-recipients.controller.ts`, `care-recipients.service.ts`: REST list/create/update และ role/owner guards
- `src/assessment/assessment.resolver.ts`, `dto/assessment.types.ts`, `assessment.service.ts`: รูปทรงผล S08 ที่ฐาน commit อ้างอิง; branch PYG-614 เพิ่ม careGroup ตาม contract นี้
- `src/identity/auth/auth.resolver.ts`: completeOnboarding คืน User ไม่ใช่โปรไฟล์
- `src/patient/patient-profile.mapper.ts`: mobility_level/supportLevel เดิม ไม่ใช่กลุ่ม ADL
- `prisma/schema.prisma`, `prisma/migrations/20261007040000_pyg564_assessment_care_group/migration.sql`: careGroup nullable ใน DB, ค่าสามกลุ่มและช่วงคะแนน
- `prisma/migrations/20261009020000_pyg567_service_packages/migration.sql`: S14 ใช้ DB codes social/homebound/bedridden
- `docs/pyg-607-s08-assessment-api-contract.md`: contract S08 ที่เสนอให้รับส่วนขยายนี้
