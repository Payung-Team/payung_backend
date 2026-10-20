# PYG-641 · S17 Required Skills — API Contract

การ์ดแม่ **PYG-570** · API **PYG-641** · DB **PYG-642** · BE **PYG-643** · QA **PYG-644** · ผู้ใช้ข้อมูล S18 **PYG-646**

วันที่ 19 ต.ค. 2026 (Asia/Bangkok) · **Draft v0.1 สำหรับรีวิว — ยังไม่มี sign-off**

เอกสารนี้กำหนดข้อมูล Required Skills ที่ server สร้างและบันทึกไว้กับ booking เพื่อให้ S18 และหน้าจอในอนาคตใช้รหัสเดียวกัน ส่งมอบเฉพาะ contract ไม่เพิ่มโค้ดหรือ migration และไม่ยืนยันว่า API ที่เสนอเปิดใช้งานแล้ว

## 1. ฐานที่ตรวจและสถานะข้อสรุป

ตรวจ checkout `codex/pyg-614-care-group` ที่ HEAD `b8b4d7cc870a55027d0c946deb887efbb6b677f5` **รวมไฟล์แก้ไขที่มีอยู่ใน working tree** เมื่อจัดทำเอกสาร โดยเฉพาะงาน PYG-652 และ S01 ที่ยังมีไฟล์ staged อยู่ ไม่ถือว่าโค้ดเหล่านั้น merge, deploy หรือทีมรับรองแล้ว

| เรื่อง | หลักฐานใน repo | Contract ฉบับเสนอ |
| --- | --- | --- |
| ชื่อทักษะใน GraphQL | มี `CareSkillItem { code, nameTh, nameEn }`; `CareSkill` เป็นชื่อ Prisma model | ใช้ `CareSkillItem` เดิม เพิ่ม `lockedProfessions` ไม่สร้าง GraphQL type ชื่อใหม่ซ้ำหน้าที่ |
| รายการทักษะของ booking | มี DB models แต่ยังไม่มี field ใน GraphQL booking types | เพิ่ม `requiredSkills: [BookingRequiredSkill!]` ตาม §3 |
| แหล่งที่มา | migration PYG-642 ระบุระดับ `adl / flag / service` | ส่ง enum `ADL / FLAG / SERVICE` ไม่ส่งรหัสข้อ ADL/Flag/บริการ |
| ล็อกวิชาชีพ | migration วันที่ 8 ต.ค. ไม่สร้าง `care_skills.locked_professions`; งาน PYG-652 ใน working tree มี `PROFESSION_LOCKED_SKILLS` สำหรับทักษะ และแยกจาก `care_activity_professions` ของกิจกรรม | อ่าน metadata ทักษะจากกติกากลาง PYG-652 ตาม §4; รอรับรอง D1 |
| ยังไม่คำนวณกับไม่มีทักษะ | Prisma อ่าน SQL NULL ใน scalar list เป็น `[]`; มติที่บันทึกใน migration ให้ใช้ `levelCalculatedAt` แยกสถานะ | แปลงเป็น API `null` หรือ `[]` ตาม §5 |
| สิทธิ์อ่าน | แต่ละ booking operation มี guard/การตรวจความสัมพันธ์ของตนเอง | รักษาสิทธิ์เดิมและเสนอ role matrix ใน §8; รอรับรอง D2 |
| ข้อผิดพลาดเชิงธุรกิจ | S08 ใช้ GraphQL `extensions.code/statusCode` และ REST HTTP 422 | ใช้รูปแบบเดียวกันกับ `SKILL_RULE_INVALID` ตาม §9 |

ข้อกำหนดที่เป็นข้อเสนอในเอกสารนี้จะเป็นข้อตกลงร่วมเมื่อผู้รับรองใน §13 ยอมรับแล้ว ส่วนมติเดิมอ้างตามคอมเมนต์ใน repo ไม่ใช่หลักฐานการอนุมัติเอกสารฉบับนี้

## 2. ขอบเขต

อยู่ในขอบเขต: รูปทักษะกลาง, รูปทักษะที่ booking ต้องการพร้อมแหล่งที่มาทั้งหมด, field ใน response, nullability, การตัดซ้ำ/เรียงลำดับ, สิทธิ์อ่าน, error และตัวอย่าง response

ไม่อยู่ในขอบเขต:

- field ระดับ booking ของ S16 / PYG-637 และสูตรคำนวณระดับ
- operation ค้นหาผู้ดูแลที่รับ booking ได้ของ S18 / PYG-646 และการบังคับตรวจวิชาชีพ/หลักฐาน
- operation หรือหน้าจอแอดมินแก้รายการทักษะหรือกติกา
- การแสดง/แก้ทักษะผู้ดูแล และการแปลงข้อมูลผู้ดูแลเดิมของ PYG-652
- หน้าจอ Required Skills ของญาติ/ผู้ดูแล และการเพิ่ม profession ผู้ช่วยพยาบาล

การอ้าง `levelCalculatedAt` ใน §5 เป็นวิธีแปลงข้อมูลจาก DB ที่มีอยู่ ไม่เพิ่ม field ระดับหรือเวลาคำนวณเข้า API ในการ์ดนี้

## 3. GraphQL SDL ที่เสนอเพิ่ม

SDL ต่อไปนี้เป็น **ส่วนเพิ่มจาก schema ปัจจุบัน** ไม่ใช่ schema ที่เปิดใช้แล้ว:

```graphql
enum RequiredSkillSource {
  ADL
  FLAG
  SERVICE
}

extend type CareSkillItem {
  lockedProfessions: [CaregiverProfession!]!
}

type BookingRequiredSkill {
  skill: CareSkillItem!
  sources: [RequiredSkillSource!]!
}

extend type BookingSummary {
  requiredSkills: [BookingRequiredSkill!]
}

extend type CaregiverBookingSummary {
  requiredSkills: [BookingRequiredSkill!]
}

extend type GroupBookingSummary {
  requiredSkills: [BookingRequiredSkill!]
}
```

`CareSkillItem` เดิมมี `code: String!`, `nameTh: String!`, `nameEn: String!` และ `CaregiverProfession` เดิมมีค่า **ตัวพิมพ์เล็ก** `general_caregiver`, `nurse`, `physiotherapist` ไม่ประกาศ enum ใหม่หรือเปลี่ยนค่าเดิม

| Field | ความหมาย/ข้อบังคับ |
| --- | --- |
| `skill.code` | รหัสกลางจาก `care_skills.code` เทียบแบบตรงตัวและคำนึงถึงตัวพิมพ์ ห้ามส่งชื่อไทย/ชื่ออังกฤษแทนรหัส |
| `skill.nameTh`, `skill.nameEn` | ชื่อจากรายการกลาง ใช้แสดงผล ไม่ใช้เป็น key ใน S18 |
| `skill.lockedProfessions` | `[]` = ไม่ล็อกวิชาชีพ; รายการไม่ว่าง = วิชาชีพที่อนุญาต ห้ามใช้ `null` แทนไม่ล็อก |
| `sources` | มีอย่างน้อย 1 ค่า ไม่มีค่าซ้ำ มีเฉพาะ enum สามค่าที่กำหนด |
| `requiredSkills` | `null` = ยังไม่เคยคำนวณ; `[]` = คำนวณแล้วไม่มีทักษะ; list ไม่รับสมาชิก `null` |

GraphQL บังคับจำนวนสมาชิกขั้นต่ำของ list ไม่ได้ BE ต้องตรวจ invariant `sources.length >= 1` เอง

**ไม่มี input ใหม่** และห้ามเพิ่ม `requiredSkills`, `sources`, `lockedProfessions` หรือรหัสทักษะที่ booking ต้องการลงใน mutation/REST DTO เพื่อให้ client กำหนดผลคำนวณ การตรวจ unknown input ใช้พฤติกรรมเดิมของแต่ละช่องทาง แต่ค่าที่ client ส่งต้องไม่มีผลต่อผลคำนวณ

## 4. ทักษะกลางและการล็อกวิชาชีพ

### 4.1 รหัสอ้างอิงร่วม

ตารางนี้ถอดชื่อและรหัสจาก seed PYG-642 ทั้ง 15 รายการ คอลัมน์ล็อกวิชาชีพถอดจาก `PROFESSION_LOCKED_SKILLS` ของงาน PYG-652 ใน checkout ปัจจุบัน เป็นชุดที่เสนอให้ S18 รับรองร่วมกัน ไม่ใช่การอนุมัติเกณฑ์ทางวิชาชีพใหม่

| code | nameTh | nameEn | lockedProfessions ที่เสนอ |
| --- | --- | --- | --- |
| `abdominal_wound_care` | ทำแผลหน้าท้อง | Abdominal wound care | `[nurse]` |
| `bathing` | อาบน้ำ / เช็ดตัว | Bathing | `[]` |
| `dementia_care` | ดูแลผู้ป่วยสมองเสื่อม | Dementia care | `[]` |
| `dressing_assist` | ช่วยแต่งตัว | Dressing assistance | `[]` |
| `feeding_assist` | ป้อนอาหาร | Feeding assistance | `[]` |
| `glucose_diet_care` | วัดน้ำตาล / คุมอาหาร | Blood glucose and diet care | `[]` |
| `injection` | ฉีดยา | Injection | `[nurse]` |
| `physiotherapy` | กายภาพบำบัด | Physiotherapy | `[physiotherapist]` |
| `pressure_ulcer_care` | ทำแผล / พลิกตัว | Pressure ulcer care and repositioning | `[]` |
| `suction` | ดูดเสมหะ | Suctioning | `[nurse]` |
| `toileting_care` | เปลี่ยนผ้าอ้อม / ดูแลการขับถ่าย | Toileting and continence care | `[]` |
| `tracheostomy_care` | ดูแลท่อเจาะคอ | Tracheostomy care | `[nurse]` |
| `transfer_assist` | ย้ายตัว / พยุงตัว | Transfer assistance | `[]` |
| `tube_feeding` | ให้อาหารทางสายยาง | Tube feeding | `[nurse]` |
| `wheelchair_push` | เข็นรถเข็น | Wheelchair pushing | `[]` |

### 4.2 แหล่งข้อมูลของ lockedProfessions — ข้อเสนอ D1

- คง `CareSkillItem` เดิมและเพิ่ม field แบบ non-null เพราะ server ให้ `[]` ได้สำหรับทักษะที่ไม่ล็อก
- ใช้กติกากลาง `src/care-skill/care-skill.constants.ts` ของ PYG-652 ที่เดียว ไม่สร้างคอลัมน์ DB ใหม่ และไม่คัดลอก map แยกให้ S17/S18
- `care_activity_professions` บอกข้อจำกัดของ **กิจกรรม** ส่วน map PYG-652 บอกข้อจำกัดของ **ทักษะ** ห้ามอนุมานว่าทักษะไม่ล็อกเพียงเพราะตาราง `care_skills` ไม่มีคอลัมน์นี้
- `careSkills(profession: String!): [CareSkillItem!]!` เดิมใช้ type ร่วม จึงเลือก field ใหม่นี้ได้ด้วย แต่การกรองรายการและลำดับของ query เดิมไม่เปลี่ยน query นี้ไม่ใช่แหล่งอ่าน snapshot ของ booking
- enum ปัจจุบันยังไม่มีผู้ช่วยพยาบาล จึงไม่สร้างรหัสใหม่หรือใช้ `general_caregiver` แทน หากอนุมัติ profession ใหม่ ต้องแก้ contract, enum และกติกากลางของทักษะ 4 รายการ `tube_feeding`, `tracheostomy_care`, `suction`, `abdominal_wound_care` ร่วมกับ S01/S18 ก่อนใช้

## 5. การรวมรายการ ค่าว่าง และลำดับ

1. ผลคำนวณเป็น union ของทักษะจาก ADL รายข้อ, Flags และบริการที่จอง ไม่ใช้คะแนน ADL รวมแทนรายข้อ
2. หนึ่ง `skill.code` มีได้หนึ่งรายการ แม้หลายกติกาหรือหลายแหล่งให้ทักษะเดียวกัน รวม `sources` ทุกแหล่งที่ให้ทักษะนั้นแล้วตัดซ้ำ
3. หลายข้อ ADL ให้ทักษะเดียวกัน เช่น bladder และ bowels ให้ `toileting_care` จะมี `sources: [ADL]` เพียงครั้งเดียว
4. ไม่มีทักษะที่ `sources` ว่าง งานพิมพ์เองใน `booking_tasks` และทักษะข้อความอิสระของผู้ดูแลไม่สร้าง Required Skills
5. **ลำดับที่เสนอ:** เรียง `requiredSkills` ตาม `skill.code` จากน้อยไปมากด้วยลำดับตัวอักษร ASCII ไม่เรียงตามชื่อแสดงผลหรือตามลำดับที่ query DB คืนมา
6. เรียง `sources` ตามลำดับตายตัว `ADL`, `FLAG`, `SERVICE` และ `lockedProfessions` ตาม `general_caregiver`, `nurse`, `physiotherapist` โดยตัดซ้ำด้วย
7. เมื่อข้อมูลที่บันทึกและ metadata กลางไม่เปลี่ยน เรียกซ้ำต้องได้รายการและลำดับเดิม

### 5.1 แยก null กับ []

| สถานะที่บันทึก | API requiredSkills | ความหมายสำหรับ client/S18 |
| --- | --- | --- |
| ยังไม่เคยคำนวณ รวม booking ก่อนฟีเจอร์ | `null` | ไม่ทราบรายการ ห้ามตีความว่าไม่ต้องใช้ทักษะ |
| คำนวณสำเร็จแล้ว ไม่มีกติกาเข้าเงื่อนไข | `[]` | ไม่มี Required Skills ตามผลคำนวณครั้งที่บันทึก |
| คำนวณสำเร็จแล้ว ได้ทักษะ | list ของ object | ต้องใช้รหัสทักษะทุกตัวในรายการ |
| คำนวณล้มเหลว | operation ตอบ error | ไม่แทนความผิดพลาดด้วย `null` หรือ `[]` |

Prisma `Booking.requiredSkills: String[]` อ่าน SQL NULL เป็น `[]` ดังนั้นห้าม map จากอาร์เรย์เพียงตัวเดียว มติที่บันทึกใน PYG-642 เดิมเสนอให้ใช้ `levelCalculatedAt` เป็นตัวบอกการคำนวณ แต่ใน checkout ยังไม่มีตัวคำนวณ S16 และ booking อาจมีผลเฉพาะ S16 มาก่อน

**แนวทาง implementation S17 ที่ใช้ในฉบับนี้ (ส่งให้ DB/BE รับรอง D3):** อ่าน `bookings.required_skills` ด้วย SQL แบบ parameterized เพื่อรักษา SQL NULL โดยตรง:

- SQL `required_skills IS NULL` → API `requiredSkills: null` แม้มีเวลา S16 อยู่แล้ว
- SQL `required_skills = '{}'` → API `[]`
- SQL อาร์เรย์มีรหัส → โหลด snapshot และ metadata กลางเป็น object ตาม SDL

ไม่เพิ่ม migration/คอลัมน์ และไม่เขียน `levelCalculatedAt` เพื่อแสร้งว่าคำนวณระดับแล้ว; ไม่ backfill หรือคำนวณตอนอ่าน เมื่อ S16 พร้อมให้เรียกตัวคำนวณทั้งสองใน transaction เดียวกันตามจุดเชื่อมที่เตรียมไว้ แนวทางนี้เปลี่ยนเฉพาะการแปลง DB → API ไม่มีการเปลี่ยนความหมาย null/[]

รายการรหัสใน `bookings.required_skills` ต้องเท่ากับเซตรหัสใน `booking_required_skills` ของ booking เดียวกัน หากข้อมูลไม่สอดคล้องถือเป็นความผิดพลาดของข้อมูล ใช้เส้นทาง internal error/logging เดิม ห้ามส่งผลสำเร็จที่ตัดรายการทิ้ง และไม่ใช้ `SKILL_RULE_INVALID` ซึ่งสงวนไว้สำหรับกติกาตาม §9

## 6. การบันทึก คำนวณใหม่ และขอบเขต snapshot

- server คำนวณตอนสร้าง booking และเมื่อข้อมูลต้นทางที่เกี่ยวข้องเปลี่ยน ก่อนยืนยัน ตามจังหวะเดียวกับ S16 การกำหนด hook และการเขียน DB เป็นงาน PYG-643
- ผลใหม่ต้องแทนผลเก่าทั้งชุด รวมลบทักษะ/แหล่งที่มาที่ไม่เข้าเงื่อนไขแล้ว การคืนค่าหลังเขียนสำเร็จต้องเป็นผลที่ commit ล่าสุด
- การอ่านทุกช่องทางคืน **ผลที่บันทึก** แม้ยังไม่ยืนยัน ไม่เรียกตัวสร้างทักษะใหม่ตอนอ่าน
- **นิยามที่เสนอ D3:** จุดหยุดคำนวณคือการเปลี่ยน `accepted → confirmed` โดย `confirmBooking` ซึ่งเขียน `confirmedAt` ในโค้ดปัจจุบัน ก่อนยืนยัน booking ที่มี careRecipientId ต้องบันทึกผลจากต้นทางล่าสุดสำเร็จ และป้องกันต้นทางเปลี่ยนแทรกระหว่างการคำนวณกับยืนยัน; booking เดิมที่ไม่มี careRecipientId คงผลไม่ทราบเป็น null ไม่สร้างโปรไฟล์หรือเดาทักษะย้อนหลัง
- หลังยืนยันแล้วเซตรหัสทักษะและ `sources` คงเดิม รวมถึงเมื่อเข้าสู่ `in_progress`, `completed` หรือยกเลิกภายหลัง การเปลี่ยน assessment/กติกาไม่เปลี่ยนผล booking นี้ การยกเลิกก่อนยืนยันไม่ใช่ trigger ให้คำนวณใหม่เอง
- booking เก่าที่ยืนยันแล้วและยังไม่เคยคำนวณคง `null` ไม่เปลี่ยนเป็น `[]` และไม่ย้อนหลังสร้างรายการ
- โครงสร้าง DB ปัจจุบันเก็บ snapshot เฉพาะรหัสและแหล่งที่มา **ชื่อและ `lockedProfessions` ใน draft นี้อ่าน metadata กลางปัจจุบัน** ไม่รับประกันข้อความหรือข้อจำกัดวิชาชีพย้อนหลัง การตรึง metadata ด้วยต้องตกลงขยาย contract/DB ต่างหาก (D1)
- การปิดใช้ทักษะภายหลังไม่ทำให้รหัสนั้นหายจาก snapshot เก่าตอนอ่าน ต้องอ่านชื่อจาก master ที่ยังอ้างอิงได้โดยไม่กรอง `isActive`; เงื่อนไข E11 ตรวจตอนสร้างผลใหม่
- S18 ใช้รหัสจากผลที่บันทึก ไม่ตีความ `null` ว่าผู้ดูแลทุกคนผ่าน การเลือกว่าจะให้ booking เดิมไปต่ออย่างไรเป็นข้อตกลงของ PYG-646

## 7. ช่องทางที่ต้องคืน field ให้สอดคล้องกัน

ตารางนี้เป็นขอบเขต implementation ที่เสนอให้ BE รับรองพร้อมสิทธิ์ใน §8 ไม่เพิ่ม operation ใหม่ ไม่เปลี่ยน arguments หรือ return type เดิม

| ช่องทาง / operation เดิม | ตำแหน่งเพิ่ม field |
| --- | --- |
| GraphQL `myBooking(id: ID!)` | `BookingSummary.requiredSkills` |
| GraphQL `myBookingHistory(input: BookingHistoryInput)` | `data[].requiredSkills` |
| GraphQL `groupBooking(bookingId: ID!, groupId: ID!)` | `BookingSummary.requiredSkills` |
| GraphQL `groupBookings(groupId: ID!)` | `GroupBookingSummary.requiredSkills` |
| GraphQL `createBookingOnBehalf(input: CreateBookingOnBehalfInput!)` | `BookingSummary.requiredSkills` ที่เพิ่งบันทึก |
| GraphQL `confirmBooking(bookingId: ID!)` | `BookingSummary.requiredSkills` ที่ยืนยันแล้ว |
| GraphQL `caregiverBooking(id: ID!)` | `CaregiverBookingSummary.requiredSkills` เมื่อผ่านสิทธิ์เดิม |
| GraphQL `caregiverBookings(input: CaregiverBookingsInput!)` และ `caregiverBookingHistory(input: CaregiverBookingHistoryInput)` | `data[].requiredSkills` |
| GraphQL `acceptBooking`, `declineBooking`, `cancelAcceptance` | `CaregiverBookingSummary.requiredSkills` |
| REST `POST /api/v1/bookings` | `BookingRest.requiredSkills` |
| REST `PATCH /api/v1/bookings/:id/cancel` | `BookingRest.requiredSkills` เดิมที่บันทึกไว้ |
| REST `PATCH /api/v1/bookings/:id/recover` | `booking.requiredSkills` ใน wrapper เดิม; จังหวะคำนวณใช้ lifecycle §6 |

REST ใช้รูป object เหมือน GraphQL และ enum เป็น string ชุดเดียวกัน ต้องมี property `requiredSkills` ใน response ของ `BookingRest` เสมอ ค่าเป็น array หรือ `null` ไม่ละ property เมื่อไม่มีผล ส่วน GraphQL ส่งเฉพาะ field ที่ client เลือก

`POST /api/v1/bookings/search-matches` ปัจจุบันคืนรายการผู้ดูแล ไม่เพิ่ม Required Skills ของ booking ลงใน response นี้ และไม่กำหนด operation matching ของ S18 ในเอกสารนี้ เช่นเดียวกับ admin projection, notification, public profile และ `PatientProfileType` ที่ไม่เพิ่ม field นี้

## 8. สิทธิ์อ่าน — ข้อเสนอ D2 รอ Sammy/เจ้าของ story รับรอง

**เสนอให้ผู้ที่ผ่านสิทธิ์อ่าน booking เดิมได้รับ Required Skills ในบริบทนั้นด้วย** โดยไม่เพิ่มสิทธิ์เข้าถึง booking ใหม่:

| ผู้เรียก / บริบท | สิทธิ์ที่เสนอ | ขอบเขตการตรวจเดิมที่ต้องคงไว้ |
| --- | --- | --- |
| `PATIENT` ผ่าน booking ส่วนตัว | อ่านได้ | booking เป็นของผู้เรียกตาม `patientId` และเงื่อนไขของ operation เดิม |
| สมาชิกครอบครัวผ่าน `groupBooking/groupBookings` | อ่านได้ | สมาชิก ACTIVE ผ่าน guard กลุ่ม และ booking อยู่ในกลุ่มนั้น ไม่ใช่ role อย่างเดียว |
| ผู้จองแทนผ่าน `createBookingOnBehalf` | อ่านได้ | ผ่านสมาชิกภาพและสิทธิ์ต่อโปรไฟล์/กลุ่มตาม mutation เดิม |
| `CAREGIVER` ผ่าน operation ฝั่งผู้ดูแล | อ่านได้ | booking ถูกมอบหมายให้ caregiver ของผู้เรียกและผ่านเงื่อนไขสถานะเดิม รวม pending ที่อ่านได้อยู่แล้ว ไม่เปิดให้ผู้ดูแลอื่น |
| `ADMIN / SUPER_ADMIN` ในบริบทงานแอดมิน | ไม่เพิ่มช่องทางใน v1 | หากต้องมี admin field ต้องระบุ projection และนโยบายให้ชัดก่อนขยาย |
| ไม่ login / คนนอกกลุ่ม / ผู้ไม่มีสิทธิ์ต่อ booking | อ่านไม่ได้ | ใช้ guard, filter, not-found/access-error เดิม |
| S18 ภายใน server | ใช้ผลที่บันทึกได้ | ไม่สร้าง public endpoint หรือให้ client ข้ามสิทธิ์ด้วยการเรียกชื่อ S18 |

การเพิ่ม field บน `BookingSummary` มีผลถึง `groupBooking` และ `createBookingOnBehalf` ด้วย ต้องรับรองทั้ง matrix ไม่ใช่เฉพาะ `myBooking` ถ้าทีมเลือกไม่ให้บางบริบทเห็น ต้องแก้ SDL/type boundary หรือ field authorization ใน contract นี้ก่อนเริ่ม BE

ห้ามใช้ `requiredSkills: null` เป็นวิธีซ่อน field จากผู้ไม่มีสิทธิ์ เพราะ null มีความหมายว่ายังไม่คำนวณ การปฏิเสธ booking ทั้งใบคงพฤติกรรมเดิม รวม `caregiverBooking` ที่เดิมคืน root null เมื่อไม่พบ/ไม่ใช่ของตน การเข้าถึงหรือ consent ของข้อมูลต้นทางไม่ถูกขยายจากการ์ดนี้; หากนโยบายต้องจำกัด Required Skills เพิ่ม ให้ระบุใน D2

## 9. Error contract

| code | จังหวะ / เงื่อนไข | ผลต่อ operation |
| --- | --- | --- |
| `SKILL_RULE_INVALID` | สร้าง/คำนวณใหม่แล้วกติกาที่เปิดใช้และเข้าเงื่อนไขอ้าง skill ที่ไม่มี หรือ `isActive = false` (E11) | ปฏิเสธการคำนวณและ operation ที่ต้องใช้ผลนั้น ไม่ข้ามกติกาเงียบ ๆ ไม่บันทึกผลบางส่วน |

- กติกาที่ปิดใช้ไม่เข้าร่วมการคำนวณ การไม่มีเงื่อนไขเข้าเกณฑ์เป็นผลสำเร็จ `[]` ไม่ใช่ error
- ตรวจสิทธิ์และความถูกต้องของ input ตามลำดับเดิมก่อนเผยผลธุรกิจ ไม่เปิดรายละเอียดกติกาให้ผู้ไม่มีสิทธิ์
- ผลระดับ S16 และ Required Skills ต้องสำเร็จพร้อมกัน ถ้า error ให้ rollback transaction ที่เขียนผลคู่นั้นและการเปลี่ยน booking ที่พึ่งผลนี้ ผลก่อนหน้าที่บันทึกสำเร็จยังอยู่ ห้ามยืนยัน booking ด้วยผลเก่าหลังคำนวณใหม่ล้มเหลว
- ไม่ใช้ `SKILL_INVALID` ของ PYG-652 แทน เพราะ code นั้นหมายถึงทักษะที่ผู้ดูแลเลือกไม่ถูกต้อง ไม่ใช่กติกา server ผิด
- ข้อผิดพลาดสิทธิ์, input รูปแบบผิด และ internal error อื่นคง code/สถานะเดิม ไม่เหมาเป็น `SKILL_RULE_INVALID`

### 9.1 GraphQL

Execution error ใช้ HTTP **200** ตามรูปแบบที่ S08 ใช้ใน checkout; สถานะธุรกิจอยู่ที่ `errors[].extensions.statusCode = 422` ไม่บังคับ GraphQL transport เป็น HTTP 422 ใช้ domain code ที่ `extensions.code` โดยตรง ไม่ซ่อนใน Nest exception wrapper ข้อผิดพลาดตรวจ schema/ยืนยันตัวตนยังใช้พฤติกรรมเดิม

ตัวอย่างเมื่อ `createBookingOnBehalf` ซึ่งเป็น non-null root สร้างผลไม่ได้:

```json
{
  "data": null,
  "errors": [
    {
      "message": "ไม่สามารถสร้างรายการทักษะที่ booking ต้องการได้ เนื่องจากกติกาทักษะไม่ถูกต้อง",
      "path": ["createBookingOnBehalf"],
      "extensions": {
        "code": "SKILL_RULE_INVALID",
        "statusCode": 422
      }
    }
  ]
}
```

`path` ใช้ชื่อ/alias ของ operation จริง และ null propagation เป็นไปตาม GraphQL SDL; server อาจเพิ่ม `locations` ได้ client ต้องใช้ code แยกกรณี ไม่เทียบข้อความภาษาไทย

### 9.2 REST

ตอบ HTTP **422**:

```json
{
  "statusCode": 422,
  "code": "SKILL_RULE_INVALID",
  "message": "ไม่สามารถสร้างรายการทักษะที่ booking ต้องการได้ เนื่องจากกติกาทักษะไม่ถูกต้อง"
}
```

ข้อความเป็นตัวอย่าง; `code` และ `statusCode` เป็นส่วนที่ผูกกับ client บันทึกรหัสกติกา/ทักษะที่ผิดใน server log เพื่อแก้การตั้งค่า ไม่กำหนด debug details เป็น public contract

## 10. Query และ response ตัวอย่าง 4 แบบ

ใช้ query เดียวกันกับทุกตัวอย่าง ตัวอย่างอธิบายรูปข้อมูลที่เสนอ ไม่ใช่ผลเรียก API จริง รหัส booking เป็นข้อมูลสมมติ ชื่อทักษะใช้ตรงกับ seed

```graphql
query BookingRequiredSkills($id: ID!) {
  myBooking(id: $id) {
    id
    requiredSkills {
      skill {
        code
        nameTh
        nameEn
        lockedProfessions
      }
      sources
    }
  }
}
```

### 10.1 ทักษะจากแหล่งเดียว

ตัวอย่างจองบริการกายภาพบำบัด `F03` และไม่มีเงื่อนไขอื่นให้ทักษะ ได้ `physiotherapy` จาก SERVICE ไม่ว่าระดับ booking เป็นระดับใด (R6):

```json
{
  "data": {
    "myBooking": {
      "id": "11111111-1111-4111-8111-111111111111",
      "requiredSkills": [
        {
          "skill": {
            "code": "physiotherapy",
            "nameTh": "กายภาพบำบัด",
            "nameEn": "Physiotherapy",
            "lockedProfessions": ["physiotherapist"]
          },
          "sources": ["SERVICE"]
        }
      ]
    }
  }
}
```

### 10.2 ทักษะเดียวจาก 2 แหล่ง

ตัวอย่างมี Flag `ng_tube` และบริการ `C04` ตาม seed ปัจจุบัน ทั้งคู่ให้ `tube_feeding` จึงมีเพียงหนึ่งรายการ พร้อม `FLAG` และ `SERVICE` เรียงตาม §5 (S17-AC4):

```json
{
  "data": {
    "myBooking": {
      "id": "22222222-2222-4222-8222-222222222222",
      "requiredSkills": [
        {
          "skill": {
            "code": "tube_feeding",
            "nameTh": "ให้อาหารทางสายยาง",
            "nameEn": "Tube feeding",
            "lockedProfessions": ["nurse"]
          },
          "sources": ["FLAG", "SERVICE"]
        }
      ]
    }
  }
}
```

### 10.3 คำนวณแล้วไม่มีทักษะ

มี assessment ที่ครบตาม S08 และคำนวณสำเร็จ แต่ไม่มีกติกาทักษะเข้าเงื่อนไข ไม่ใช่กรณีไม่มี assessment:

```json
{
  "data": {
    "myBooking": {
      "id": "33333333-3333-4333-8333-333333333333",
      "requiredSkills": []
    }
  }
}
```

### 10.4 booking เดิมที่ยังไม่เคยคำนวณ

```json
{
  "data": {
    "myBooking": {
      "id": "44444444-4444-4444-8444-444444444444",
      "requiredSkills": null
    }
  }
}
```

### 10.5 ตัวอย่างเสริม: หลายทักษะและไม่ล็อกวิชาชีพ

กรณี transfers = 1 และ bathing = 0 โดยข้ออื่นไม่ให้ทักษะ ต้องเรียง `bathing` ก่อน `transfer_assist` ไม่ตามลำดับประเมิน (S17-AC6):

```json
{
  "data": {
    "myBooking": {
      "id": "55555555-5555-4555-8555-555555555555",
      "requiredSkills": [
        {
          "skill": {
            "code": "bathing",
            "nameTh": "อาบน้ำ / เช็ดตัว",
            "nameEn": "Bathing",
            "lockedProfessions": []
          },
          "sources": ["ADL"]
        },
        {
          "skill": {
            "code": "transfer_assist",
            "nameTh": "ย้ายตัว / พยุงตัว",
            "nameEn": "Transfer assistance",
            "lockedProfessions": []
          },
          "sources": ["ADL"]
        }
      ]
    }
  }
}
```

## 11. ข้อแตกต่างของ story กับ seed และจุดส่งต่อ BE

ไม่ใช้เอกสาร API นี้ตัดสินเกณฑ์ทางคลินิกเพิ่มเติม ต้องให้เจ้าของกติกายืนยันแหล่งฉบับล่าสุด:

| ประเด็น | สิ่งที่พบ / ข้อกำหนดส่งต่อ |
| --- | --- |
| จำนวนกติกา | story ที่แนบระบุ ADL 6 / Flags 5 / บริการ 3 แต่ seed ใน repo มีแถว ADL 7 / Flags 5 / บริการ 6 รวม 18 แถว อาจต่างระดับการนับ ต้องให้ Sammy/DB ยืนยันว่าชุดใดเป็นฉบับใช้งาน ไม่อ้างว่าตรงกันแล้ว |
| ADL ไม่แน่ใจ (E5) | พบมติใน contract S08 §1/§ท้าย: Sammy 9 ต.ค. 2026 ให้ null ใช้ 0 ทั้งคิดคะแนนและเทียบกติกาทักษะ จึงใช้ normalization นี้ฝั่ง server โดยยังเก็บคำตอบ null ตามเดิม |
| Flag `unsure` จากระบบ (E6) | ส่ง system Flag `unsure` เข้าตัวเทียบตารางเมื่อ `hasUnsureFlag = true`; seed ปัจจุบันไม่มีกติกาทักษะของรหัสนี้จึงไม่เพิ่มทักษะโดยลำพัง ไม่เขียนกติกาหรือรหัสทักษะใหม่ตายตัว หากทีมเพิ่มกติกาที่เปิดใช้ในตารางจึงมีผลตามข้อมูล |
| ไม่มี assessment (E9) | ใช้ booking gate ของ S08 และ error `ASSESSMENT_REQUIRED` เดิม ไม่ fallback จาก mobility/medical_conditions และไม่คืน `[]` ว่าคำนวณผ่าน |
| source แบบละเอียด | v1 ใช้ enum ระดับแหล่งตาม DB หากต้องระบุ ADL ข้อใด/Flag ใด/บริการใด ต้องเปลี่ยน `sources` เป็น object ที่มีรหัสต้นทางใน contract นี้ก่อน BE/DB เริ่ม ไม่เพิ่มข้อมูลคนละรูปใต้ enum เดิม |
| ชุดรหัสฝั่ง S18 | ใช้ `care_skills.code` ตาม §4; ข้อความอิสระ/รหัสเก่าฝั่งผู้ดูแลไม่ถือเป็นรหัสร่วม งานย้ายข้อมูลของ PYG-652 ต้องพร้อมก่อน S18 ใช้เทียบจริง |

## 12. ความเข้ากันได้และรายการตรวจรับ

- เปลี่ยน schema แบบเพิ่ม field/type/enum ใหม่เท่านั้น ไม่เปลี่ยนชื่อ ชนิด หรือ nullability ของ field เดิม และไม่เปลี่ยน operation/input เดิม
- GraphQL client เดิมที่ไม่เลือก field ใหม่ต้องทำงานได้เหมือนเดิม REST client ต้องรับ property เพิ่มได้; ให้ตรวจ consumer ที่ใช้ strict response validation ก่อนเปิดใช้
- ชุดรหัสทักษะไม่ใช่ GraphQL enum เพื่อให้เพิ่มทักษะกลางโดยไม่ต้องเพิ่ม enum value; source enum มีเพียงสามค่าตาม contract นี้
- ลำดับ `careSkills` เดิมไม่ถูกเปลี่ยนเป็นลำดับ Required Skills; การเรียงใน §5 ใช้กับรายการบน booking

รายการต่อไปนี้เป็นเกณฑ์ส่งต่อ PYG-644 ไม่ใช่รายงานว่าทดสอบ implementation ผ่านแล้ว:

| กรณีตรวจรับ | ผลที่ต้องได้ |
| --- | --- |
| ทักษะซ้ำข้ามแหล่ง / หลายข้อในแหล่งเดียว | หนึ่งรายการต่อ code, sources ครบและไม่ซ้ำ (AC4) |
| หลายทักษะ / สลับลำดับข้อมูล DB | response เรียง code และ sources ตาม §5 เสมอ |
| คำนวณแล้วไม่มีทักษะ / booking เก่า | แยก `[]` กับ `null` ได้ทั้ง GraphQL และ REST |
| แก้ต้นทางก่อนยืนยัน | คืนผลใหม่ที่ commit แล้ว; รายการที่ไม่เข้าเกณฑ์ต้องหาย (รองรับ AC5/AC8) |
| อ่านซ้ำหลังยืนยัน / เปลี่ยนกติกาหลังยืนยัน | เซตรหัสและ sources ที่บันทึกไม่เปลี่ยน และไม่สร้างสดตอนอ่าน |
| กติกาที่เข้าเงื่อนไขอ้างทักษะไม่มี/ปิดใช้ | `SKILL_RULE_INVALID`, สถานะธุรกิจ 422, ไม่มีการเขียนผลบางส่วน |
| ทักษะถูกปิดใช้ภายหลังยืนยัน | ยังอ่านรหัสและ sources ที่บันทึกไว้ได้ ไม่ถูกกรองหาย |
| ไม่ผ่านสิทธิ์ booking / สมาชิกออกจากกลุ่ม | คงการปฏิเสธหรือกรองตามช่องทางเดิม ไม่เปิดเผย Required Skills |
| client เวอร์ชันเดิม | query/input เดิมและ field เดิมไม่เปลี่ยน |

## 13. ประเด็นรอรับรองและ Definition of Done

ยังไม่ได้ระบุชื่อบุคคลเจ้าของการ์ด BE/DB/S18 จากแหล่งงาน จึงระบุผู้รับผิดชอบตามการ์ด ไม่สมมติว่ารีวิวแล้ว:

| ID | เรื่องที่ต้องรับรอง | ผู้ตัดสินใจ / ผู้รับรอง | สถานะ |
| --- | --- | --- | --- |
| D1 | ใช้ `CareSkillItem` ร่วม เพิ่ม `lockedProfessions` จากกติกากลาง PYG-652; ขอบเขต snapshot เฉพาะ code/sources; ระหว่างยังไม่มีผู้ช่วยพยาบาลใช้ชุด profession ปัจจุบัน | Sammy/เจ้าของ story + เจ้าของ PYG-643, PYG-642, PYG-646 และผู้ดูแล PYG-652 | รอ |
| D2 | role matrix รวมสมาชิกกลุ่ม ผู้ดูแลที่ได้รับมอบหมาย และช่องทางที่คืน field ตาม §7–8 | Sammy/เจ้าของ story + เจ้าของ PYG-643 และ PYG-646 | รอ |
| D3 | ยืนยันร่วมกับ S16 ว่าหยุดที่ confirmed; รับรองการอ่าน SQL NULL โดยตรงแทน levelCalculatedAt และจุดเชื่อม S16 ที่ยังไม่มี implementation | เจ้าของ S16 + เจ้าของ PYG-643 และ PYG-642 | รอ |
| D4 | รับรอง enum source ระดับแหล่ง, การเรียง, null/[], error GraphQL/REST และชุดรหัสใน §4 สำหรับ S18 | เจ้าของ PYG-643, PYG-642 และ PYG-646 | รอ |
| D5 | ยืนยันกติกาฉบับล่าสุด จำนวนแถว seed, ตาราง Flag unsure ตาม §11; ADL null มีมติ S08 แล้ว | Sammy/เจ้าของกติกา + เจ้าของ PYG-642 และ PYG-643 | รอ; ส่งต่อก่อนเริ่ม BE |

Checklist ของการ์ด API:

- [x] เขียน draft contract โดยเทียบชื่อกับ schema/โค้ดใน checkout
- [x] มี type, nullability, deduplication, ลำดับ, role matrix เสนอ และ error contract
- [x] มี response บังคับทั้ง 4 แบบ และตัวอย่างหลายทักษะเพิ่มเติม
- [x] ระบุเรื่องค้างและเจ้าของตามการ์ดชัดเจน
- [ ] แนบ/คัดลอกเอกสารนี้ลง PYG-641 หรือ Confluence แล้วใส่ลิงก์กลับในการ์ด
- [ ] เจ้าของ PYG-643 รีวิวและรับรอง พร้อมชื่อ วันที่ และลิงก์คอมเมนต์
- [ ] เจ้าของ PYG-642 รีวิวและรับรอง พร้อมชื่อ วันที่ และลิงก์คอมเมนต์
- [ ] เจ้าของ PYG-646 รับรองว่ารหัสและรูปข้อมูลตรงกับที่ S18 ใช้ พร้อมชื่อ วันที่ และลิงก์คอมเมนต์
- [ ] บันทึกผล D1–D4 หรือแก้เอกสารตามมติจริง; D5 ต้องมีมติหรือระบุผู้รับช่วง/การ์ดติดตามก่อนเริ่ม BE

**สถานะเอกสารนี้: พร้อมส่งรีวิว ยังไม่ใช่หลักฐานปิด PYG-641 หรือ story แม่ PYG-570** การ์ด contract ไม่ต้องรอ implementation ของ PYG-643 แต่ห้ามใส่เครื่องหมายว่ารับรองแล้วแทนเจ้าของงาน

การตรวจเอกสาร: SDL ส่วนเพิ่มประกอบกับ `src/schema.gql` ปัจจุบันผ่านการตรวจ schema และ query ตัวอย่างผ่านการตรวจด้วย GraphQL library ของ repo; JSON ทั้ง 7 บล็อกอ่านได้และตรวจลำดับ/ความไม่ซ้ำของตัวอย่างแล้ว ผลนี้ยืนยันรูปเอกสารเท่านั้น ไม่ใช่ integration test ของ API ที่ยังไม่ได้พัฒนา

## 14. แหล่งอ้างอิงใน repo

- [GraphQL schema](../src/schema.gql) — ชื่อ type/operation ปัจจุบัน
- [CareSkillItem](../src/care-skill/entities/care-skill.entity.ts), [query รายการทักษะ](../src/care-skill/care-skill.resolver.ts), [service](../src/care-skill/care-skill.service.ts)
- [กติกาล็อกทักษะ PYG-652](../src/care-skill/care-skill.constants.ts), [CaregiverProfession S01](../src/identity/kyc/profession.constants.ts)
- [โครงสร้าง DB PYG-642 และมติที่บันทึกไว้](../prisma/migrations/20261008100000_pyg570_required_skills/migration.sql), [seed ทักษะและกติกา](../prisma/migrations/20261009000000_pyg570_seed_required_skills/migration.sql), [Prisma schema](../prisma/schema.prisma)
- [Booking resolver](../src/booking/booking.resolver.ts), [Booking service](../src/booking/booking.service.ts), [REST controller](../src/booking/booking.controller.ts), [REST response types](../src/booking/dto/booking-rest.types.ts)
- [Caregiver booking resolver](../src/booking/caregiver-booking.resolver.ts), [family booking resolver](../src/family-group/family-booking.resolver.ts)
- [S08 error implementation](../src/assessment/assessment.errors.ts), [S08 contract](pyg-607-s08-assessment-api-contract.md)
- เนื้อหาการ์ด API และ story S17 ที่ผู้ใช้ส่งในแชตนี้ ใช้เป็นข้อกำหนดตั้งต้น; ยังไม่มีลิงก์ Confluence/บันทึก sign-off ที่ยืนยันได้

## 15. สถานะ implementation PYG-643 (19 ต.ค. 2026)

ผู้ใช้อนุญาตให้ทำ S17 ในจุดที่มีอยู่ และเตรียมจุดเชื่อม S15/S16 โดยไม่เพิ่ม API แก้กิจกรรมใหม่ งานสร้าง/แก้ assessment/ยืนยันและ response ใช้รูปข้อมูลในเอกสารนี้; `recalculateBookingRequiredSkills(tx, bookingId, transport)` เป็นจุดให้ S15/S16 เรียกหลังเปลี่ยนข้อมูลใน transaction เดียวกัน ยังไม่ได้อ้างว่าการเชื่อม API ที่ยังไม่มีเสร็จแล้ว

บริการใน seed S17 ใช้รหัสกิจกรรม T-01 เช่น F03 ส่วน booking มี serviceType ค่าเดี่ยว; ตัวเชื่อมใช้ serviceType และกิจกรรมที่บันทึกไว้ โดย physiotherapy ชี้ F03 ตาม R6 ที่กำหนดชัด ไม่ map medication ไป injection และไม่ใช้ booking_tasks เป็น input
