# PYG-637 · S16 Booking Level — API Contract

การ์ดแม่ **PYG-569** · API **PYG-637** · DB **PYG-638** · BE **PYG-639** · QA **PYG-640** · ผู้ใช้ข้อมูล S18 **PYG-646**

20 ต.ค. 2026 (Asia/Bangkok) · **Draft v0.1 สำหรับรีวิว — ไม่ใช่หลักฐาน sign-off ของ BE/S18**

เอกสารนี้เทียบชื่อกับ GraphQL schema, enum S02, S08/S09, S15 และ DB migrations ที่มีใน repo การเขียนเอกสารไม่เท่ากับทีมรับรองหรือ deploy แล้ว

## 1. มติที่ยึดและสิ่งที่แทนข้อเสนอเดิม

- ใช้ `CareLevel` ตัวเดิมของ S02 จาก `src/common/care-level/care-level.ts` ไม่สร้าง enum ระดับใหม่: GraphQL/REST `BASIC`, `INTERMEDIATE`, `ADVANCED`; DB `basic`, `intermediate`, `advanced`
- ADL รวม 12–20 → BASIC, 5–11 → INTERMEDIATE, 0–4 → ADVANCED โดยใช้ตัวจัดกลุ่มและช่วงคะแนนของ S09 ร่วมกัน ไม่เขียนช่วงซ้ำ และไม่ใช้กลุ่มของบัญชีผู้จองแทนคะแนนของ careRecipientId ที่จองให้
- **มติ Sammy 9 ต.ค. ที่ผู้ใช้ยืนยัน: F03 เป็น ADVANCED** แทนมติ 8 ต.ค. ที่เคยเป็น NULL/ไม่มีผล ข้อยกเว้นเดิม S16-R6/E3/E4 และผล AC4/AC8 ที่อาศัยข้อยกเว้นนั้นต้องปรับตามมติใหม่ ห้ามทำ test ให้ F03 เป็น no-effect ตามภาพเก่า
- ADL ไม่แน่ใจเก็บ null แต่รวมคะแนนเป็น 0 ตาม S08; Flag ระบบมาจาก `hasUnsureFlag` ไม่ใช่สมาชิก `flags`
- ผู้ใช้ยืนยัน 20 ต.ค.: Flag ที่เลือกแต่แถวกติกาปิดใช้งานถือว่าไม่มี active rule → `BOOKING_LEVEL_RULE_MISSING`
- สำหรับบริการ: active override ใน `booking_level_rules` มาก่อน; ถ้าไม่มี active override ใช้ `care_activities.care_level` จึงไม่ถือว่าไม่มีแถว service override เป็น error โดยลำพัง
- คง null สำหรับเกณฑ์ที่ไม่มีผล ไม่เก็บ BASIC แทน; เรื่องสิทธิ์ราย field ยังเป็นข้อเสนอ §5 รอเจ้าของรับรอง

## 2. GraphQL SDL ที่เพิ่ม

```graphql
type BookingLevelBreakdown {
  adl: CareLevel!
  flags: CareLevel
  services: CareLevel
  calculatedAt: DateTime!
}

extend type BookingSummary {
  requiredLevel: CareLevel
  levelBreakdown: BookingLevelBreakdown
}

extend type CaregiverBookingSummary {
  requiredLevel: CareLevel
  levelBreakdown: BookingLevelBreakdown
}

extend type GroupBookingSummary {
  requiredLevel: CareLevel
  levelBreakdown: BookingLevelBreakdown
}
```

`CareLevel` และ `DateTime` เป็นชนิดเดิม ไม่ประกาศซ้ำ `adl` เป็น non-null ภายใน breakdown เพราะผลคำนวณที่สำเร็จต้องมีคะแนน ADL ที่ถูกต้อง; เมื่อยังไม่คำนวณให้ทั้ง breakdown เป็น null ไม่ส่ง object ที่ ADL หาย

ไม่มี `requiredLevel`, `levelBreakdown`, ระดับรายเกณฑ์ หรือเวลาคำนวณใน input/DTO ของ client ทุกช่องทางเป็นข้อมูลที่ server สร้างเท่านั้น เพิ่ม field/type โดยไม่ลบ เปลี่ยนชนิด หรือ nullability ของ field เดิม

REST `BookingRest` เพิ่ม property `requiredLevel` และ `levelBreakdown` เสมอ (ไม่ละ property เมื่อไม่มีผล) ใช้โครงสร้างเดียวกันและชื่อ enum ตัวพิมพ์ใหญ่เหมือน GraphQL; calculatedAt เป็น ISO 8601 UTC เช่น `2026-10-20T08:00:00.000Z` ฝั่ง GraphQL ส่งเฉพาะ field ที่ client เลือก

## 3. ความหมาย null และข้อมูลที่บันทึก

| Field | คำนวณแล้ว | ยังไม่เคยคำนวณ |
| --- | --- | --- |
| requiredLevel | ระดับสูงสุดของ 3 เกณฑ์ ต้องมีค่า | null |
| levelBreakdown | object พร้อม calculatedAt | null |
| levelBreakdown.adl | ต้องมีค่า จาก ADL รวม 0–20 | ไม่มี object breakdown |
| levelBreakdown.flags | null = ไม่มี Flag ที่มีผล รวมกรณี flags=[] และ hasUnsureFlag=false | ไม่มี object breakdown |
| levelBreakdown.services | null = ไม่มีบริการ/กิจกรรมที่มีผล หรือ active override ระบุ no-effect โดยชัดเจน | ไม่มี object breakdown |
| levelBreakdown.calculatedAt | เวลาผลคำนวณชุดที่บันทึก ไม่ใช่เวลาที่อ่าน API | ไม่มี object breakdown |

ใช้ `bookings.level_calculated_at` เป็นตัวบอกว่าคำนวณระดับแล้ว ไม่ใช้ requiredLevel หรือ Required Skills array เดาเวลา สถานะ computed ต้องมี required_level และ level_from_adl ถูกต้อง flags/services รับ SQL NULL ตามความหมาย no-effect

mapping: required_level → requiredLevel; level_from_adl / level_from_flags / level_from_services → breakdown.adl/flags/services; level_calculated_at → breakdown.calculatedAt

- booking เดิมยังไม่เคยคำนวณคืนทั้งสอง field เป็น null ไม่ backfill/เดาจาก mobility_level/medical_conditions ตอนอ่าน
- อ่านค่าที่บันทึกทุกครั้ง ไม่อ่าน assessment/rules มาคำนวณสด แม้ booking ยังไม่ยืนยัน
- ถ้ามี calculatedAt แต่ค่าระดับที่จำเป็นหาย/ไม่รู้จัก ใช้ error ระบบเดิม ไม่ตีว่าเป็น booking เก่า และไม่คืน BASIC กลบข้อมูลเสีย
- แม้เกณฑ์ flags/services ไม่มีผล ระดับสุดท้ายยังได้อย่างน้อยจาก ADL เสมอ; null ไม่ได้แปลว่าผู้ดูแลทุกระดับผ่าน S18

## 4. แหล่งข้อมูลและ lifecycle

ตัวคำนวณรับคะแนนรวมและ Flags ของ assessment ล่าสุดของ **careRecipientId ใน booking** (`care_recipient_assessments` เก็บหนึ่งแถวต่อโปรไฟล์ด้วย unique/upsert ของ S08) ไม่ใช้ยอดรวมจาก client และไม่รับ booking_tasks เป็นบริการ

| ต้นเหตุ / operation เดิม | สิ่งที่ต้องทำ / response |
| --- | --- |
| REST POST /api/v1/bookings | หลังผ่าน S08 gate และบันทึกกิจกรรม S15 แล้ว คำนวณระดับ+Required Skills ใน transaction สร้าง booking เดียวกัน; คืนสอง field ระดับล่าสุด |
| GraphQL createBookingOnBehalf | ใช้จุดสร้างเดียวกับ REST และ assessment ของผู้สูงอายุเป้าหมาย; BookingSummary ส่งระดับที่บันทึกเมื่อ client เลือก |
| GraphQL submitCareRecipientAssessment | หลัง upsert คำตอบ/คะแนนแล้ว คำนวณ booking ของโปรไฟล์นั้นที่ยังไม่ยืนยันทั้งหมดใน transaction เดียวกัน ผล submit ยังเป็น assessment type เดิม ไม่เพิ่ม booking list ใน response; query booking ครั้งถัดไปอ่านระดับใหม่ทันที |
| GraphQL confirmBooking | ใน transaction เดียวกัน refresh ผลจากต้นทางล่าสุดก่อนเปลี่ยน accepted → confirmed และเขียน confirmedAt; คืนระดับสุดท้ายที่ยืนยันแล้ว |
| เปลี่ยนบริการ/กิจกรรมของ booking | writer ของ operation นั้นต้องเรียก `recalculateBookingRequirements(tx, bookingId)` หลังแก้ต้นทางใน transaction เดียวกัน ปัจจุบัน S15 มีการเลือกกิจกรรมตอนสร้าง; ยังไม่มี API แก้บริการ/รายการกิจกรรมของ booking จึงเตรียม hook ไม่เพิ่ม operation นอก contract |
| อ่าน myBooking / myBookingHistory / groupBooking / groupBookings | คืนผลที่บันทึก ไม่ trigger คำนวณ |
| caregiverBooking / caregiverBookings / caregiverBookingHistory / acceptBooking / declineBooking / cancelAcceptance | คืนผลที่บันทึกใน CaregiverBookingSummary ไม่เปลี่ยนระดับเพียงเพราะเปลี่ยนผู้ดูแลหรือการตอบรับ |
| REST cancel / recover | คืนระดับที่บันทึกไว้ใน BookingRest หรือ wrapper.booking ตามเดิม ไม่ถือว่าการเปลี่ยนสถานะอย่างเดียวเป็นการเปลี่ยนต้นทาง |

ก่อนยืนยัน ช่วงสถานะที่คำนวณใหม่ได้คือ unmatched/pending/accepted/rejected โดย confirmedAt ต้องเป็น null; rejected ยังอาจ recover ได้ การยืนยันหมายถึง **accepted → confirmed ของ confirmBooking** ไม่ใช่ caregiver accept หรือการชำระเงิน ภายหลัง confirmedAt มีค่าแล้วต้องไม่คำนวณใหม่ แม้สถานะต่อมาจะเป็น cancelled/in_progress/completed

ระดับและ Required Skills ต้องมาจาก assessment ฉบับเดียวกัน ใช้ lock ลำดับ recipient ก่อน booking และเขียนระดับทั้ง 4 ค่า + calculatedAt + required_skills + booking_required_skills ใน outer transaction เดียวกัน ถ้าฝั่งใดล้มเหลวต้อง rollback ทั้งหมด ไม่มีผลบางส่วนหรือ timestamp ที่อ้างว่าคำนวณแล้วทั้งที่ skills ไม่สำเร็จ

การแก้ตารางกติกาหรือ master กิจกรรมไม่สร้าง background recalculation ใน story นี้ ผลก่อนยืนยันจะใช้ข้อมูลล่าสุดเมื่อมี trigger ที่กำหนด/ก่อน confirm; ผลที่ยืนยันแล้วคงเดิม ไม่มี operation แอดมินแก้ rules ใน contract นี้

## 5. สิทธิ์อ่าน — ข้อเสนอรอ Sammy/BE/S18 รับรอง

| บริบท | requiredLevel | levelBreakdown | เงื่อนไข |
| --- | --- | --- | --- |
| PATIENT ผ่าน booking ส่วนตัว | อ่านได้ | อ่านได้ | ผ่านสิทธิ์ต่อ booking เดิม |
| ญาติผ่าน groupBooking / groupBookings | อ่านได้ | อ่านได้ | สมาชิก ACTIVE ผ่าน guard และ booking อยู่กลุ่มที่ตนอ่านได้ ตาม consent/filter เดิม |
| CAREGIVER ผ่าน operation ผู้ดูแล | อ่านได้ | อ่านได้ | ได้รับมอบหมาย booking นั้นและผ่านเงื่อนไขเดิม รวม pending ที่เดิมอ่านได้ |
| ADMIN/SUPER_ADMIN ในบริบทงานแอดมิน | ไม่เพิ่ม projection ใหม่ | ไม่เพิ่ม projection ใหม่ | ถ้าจะเพิ่มต้องระบุ type/operation แยกก่อน |
| S18 ภายใน server | ใช้ได้ | ใช้ได้ | ใช้ระดับที่บันทึกและลำดับ CareLevel เดียวกัน ไม่มี endpoint ข้ามสิทธิ์ |
| ไม่มีสิทธิ์ / ไม่ login | ไม่ได้ | ไม่ได้ | guard/filter/error เดิม ไม่คืน field=null แทน access denial |

การเพิ่ม field บน BookingSummary ครอบคลุมทั้ง groupBooking และจองแทนด้วย ไม่ให้สิทธิ์อ่าน booking ใหม่แก่ใคร หากทีมไม่ให้ญาติเห็น breakdown ต้องปรับ matrix และ type/field authorization ที่นี่ก่อนเปิดใช้ ไม่อ้างว่าทีมเคาะ admin-only แล้วโดยไม่มีหลักฐาน

## 6. กติกาและ error

Flags: เลือก exact active row ตาม `(flag, code, variant)`; dementiaSevere=true และมี dementia ใช้ severe; false/null ใช้กรณีทั่วไป ไม่ fallback จากแถว severe ที่หายไปเป็นกรณีทั่วไป hasUnsureFlag=true เพิ่ม unsure แม้ flags=[] หรือ noSpecialConditions=true

บริการ: แต่ละกิจกรรมอ่าน code และ care_level จาก master S15; active override `(service, code, '')` มีลำดับก่อน fallback และ level=NULL เป็น explicit no-effect ไม่ fallback ต่อ แถวปิดใช้งานถูกละเว้น ถ้าไม่มี active override ใช้ care_level ที่ถูกต้องของกิจกรรม หากทั้งสองทางไม่มีระดับที่ใช้ได้ต้อง error ไม่เดา BASIC

การเลือก serviceType=physiotherapy โดยยังไม่มี activityIds หมายถึงบริการ F03 เช่นเดียวกับ S17: อ่าน F03 จาก DB กติกา/กิจกรรม **ไม่เขียนระดับ ADVANCED ตายตัวใน adapter** รหัสประเภทบริการทั่วไปไม่ใช่รหัสกิจกรรม และไม่แปลง tasks/free text เป็นกิจกรรม

| Code | เงื่อนไข | สถานะธุรกิจ |
| --- | --- | --- |
| BOOKING_LEVEL_RULE_MISSING | Flag ไม่มี active exact rule รวมแถวปิดใช้; หรือบริการไม่มีทั้ง active override และ fallback level | 422 |
| BOOKING_LEVEL_RULE_INVALID | กติกา/ระดับ fallback นอกชุด CareLevel หรือ active key ซ้ำผิดโครงสร้าง | 422 |
| BOOKING_LEVEL_INPUT_INVALID | ADL รวมไม่เป็นจำนวนเต็ม 0–20 ไม่ clamp/เดาระดับ | 422 |
| ASSESSMENT_REQUIRED | ไม่มี assessment ของโปรไฟล์เป้าหมาย ใช้ gate/error S08 เดิม | 422 |

สอง code INVALID เป็นส่วนเพิ่มที่เสนอใน contract เพื่อแยก input เสียกับกติกาเสีย เจ้าของ BE/S18 ต้องรับรองชื่อก่อนเปิดใช้ error สิทธิ์และ internal DB ใช้ของเดิม ไม่เปลี่ยนเป็น RULE_MISSING

GraphQL execution error ใช้ HTTP 200 และ `errors[].extensions.code`, `extensions.statusCode=422` ไม่สัญญาว่า transport จะตอบ HTTP 422; schema coercion/auth error ใช้พฤติกรรมเดิม REST ตอบ HTTP 422 และ `{statusCode, code, message}` ไม่ส่ง SQL/ข้อมูลสุขภาพดิบ ตัวอย่าง:

```json
{"data":null,"errors":[{"message":"ไม่สามารถคำนวณระดับ booking ได้ เนื่องจากข้อมูลหรือกติกาไม่ถูกต้อง","path":["createBookingOnBehalf"],"extensions":{"code":"BOOKING_LEVEL_RULE_MISSING","statusCode":422}}]}
```

## 7. Query และ response ตัวอย่าง

```graphql
query BookingLevel($id: ID!) {
  myBooking(id: $id) {
    id
    requiredLevel
    levelBreakdown { adl flags services calculatedAt }
  }
}
```

### 7.1 ครบ 3 เกณฑ์

ADL=10 → INTERMEDIATE, Flag injection → ADVANCED, กิจกรรมบริการระดับ BASIC → BASIC ผลสุดท้าย ADVANCED:

```json
{"data":{"myBooking":{"id":"11111111-1111-4111-8111-111111111111","requiredLevel":"ADVANCED","levelBreakdown":{"adl":"INTERMEDIATE","flags":"ADVANCED","services":"BASIC","calculatedAt":"2026-10-20T08:00:00.000Z"}}}}
```

### 7.2 จองเฉพาะกายภาพบำบัด — มติแก้ไข 9 ต.ค.

ADL=20, ไม่มี Flags, F03 ตามกติกาใหม่เป็น ADVANCED จึงได้ ADVANCED แม้ ADL เป็น BASIC:

```json
{"data":{"myBooking":{"id":"22222222-2222-4222-8222-222222222222","requiredLevel":"ADVANCED","levelBreakdown":{"adl":"BASIC","flags":null,"services":"ADVANCED","calculatedAt":"2026-10-20T08:00:00.000Z"}}}}
```

### 7.3 booking เดิมที่ยังไม่เคยคำนวณ

```json
{"data":{"myBooking":{"id":"33333333-3333-4333-8333-333333333333","requiredLevel":null,"levelBreakdown":null}}}
```

### 7.4 คำนวณแล้ว แต่ flags/services ไม่มีผล

ADL=20, ไม่มี Flag และไม่มีบริการ/กิจกรรมที่เข้าเกณฑ์บริการ ไม่ใช่ booking ที่ยังไม่คำนวณ:

```json
{"data":{"myBooking":{"id":"44444444-4444-4444-8444-444444444444","requiredLevel":"BASIC","levelBreakdown":{"adl":"BASIC","flags":null,"services":null,"calculatedAt":"2026-10-20T08:00:00.000Z"}}}}
```

ตัวอย่างเป็นข้อมูลสมมติ รูปแบบ REST ตัด data.myBooking wrapper ออกและคืน fields เดียวกันใน booking object ที่มี fields เดิมอยู่ครบ

## 8. ข้อค้างและ DoD

| ID | เรื่อง | เจ้าของ / สถานะ |
| --- | --- | --- |
| D1 | สิทธิ์ราย field รวมญาติและผู้ดูแล/การเห็น breakdown | Sammy + เจ้าของ PYG-639/646 รับรอง matrix §5; ยังไม่มี sign-off |
| D2 | null ของเกณฑ์ไม่มีผล, breakdown.adl non-null ภายใน object, error codes/transport | เจ้าของ PYG-639/646 รับรอง; draft ใช้ null ไม่แทนด้วย BASIC |
| D3 | จุดยืนยันและ hook ของ API แก้บริการ/กิจกรรมที่ยังไม่มี | เจ้าของ PYG-639/S15 รับรอง lifecycle §4 |
| D4 | 5 เคสจาก infographic ล่าสุด | ยังไม่มีค่าอินพุตในการ์ด/ข้อความผู้ใช้ มีเพียงผล ต้น/กลาง/สูง/กลาง/ต้น และเนื้อหาเก่าที่อาศัย F03 no-effect; PYG-640/Sammy ต้องแนบต้นฉบับที่แก้ตามมติ F03 ใหม่ ห้ามอ้างว่าทดสอบ 5 เคสต้นฉบับแล้ว |
| D5 | DB rollout ของ F03 advanced | PYG-638/ผู้ deploy ยืนยัน migration 20261009010000_pyg638_f03_level_advanced (PR #119) ก่อนเปิด S16; ไม่แก้ migration เก่าที่ใช้แล้ว |

- [x] ใช้ enum CareLevel ของ S02 ตัวเดิมและช่วงคะแนนของ S09
- [x] กำหนด fields, nullability, snapshot, lifecycle, role matrix และ error
- [x] มี response บังคับครบ 3 แบบและตัวอย่าง computed no-effect เพิ่ม
- [ ] แนบเอกสารนี้ใน PYG-637/Confluence พร้อมลิงก์
- [ ] เจ้าของ PYG-639 และ PYG-646 รีวิวรับรองพร้อมชื่อ วันที่ ลิงก์คอมเมนต์
- [ ] บันทึกข้อสรุปสิทธิ์และ null หรือชื่อผู้รับช่วงให้ชัดเจนก่อนเปิด API จริง

ผล implementation และ baseline: [รายงาน PYG-639](pyg-639-s16-booking-level-validation.md) · ตรวจข้อมูลก่อนเปิดใช้ด้วย [read-only readiness SQL](../prisma/checks/booking_level_readiness.sql)

## 9. แหล่งอ้างอิง

- [CareLevel ของ S02](../src/common/care-level/care-level.ts), [contract S02](pyg579-caregiver-care-level-api-contract.md), [ช่วงคะแนน S09](../src/common/care-group.ts)
- [โครงสร้าง PYG-638](../prisma/migrations/20261008050000_pyg569_booking_required_level/migration.sql), [seed แรก](../prisma/migrations/20261008060000_pyg569_seed_booking_level_rules/migration.sql), [Flags 10 แถว](../prisma/migrations/20261008070000_pyg569_seed_flag_level_rules/migration.sql), [แก้ F03 เป็น advanced](../prisma/migrations/20261009010000_pyg638_f03_level_advanced/migration.sql)
- [PR #119](https://github.com/Payung-Team/payung_backend/pull/119) และ [PR #113](https://github.com/Payung-Team/payung_backend/pull/113) ประกอบเนื้อหาที่มีใน repo ไม่อ้างสถานะ deploy จากข้อความเก่า
- [S08 contract](pyg-607-s08-assessment-api-contract.md), [Booking service](../src/booking/booking.service.ts), [S15 service](../src/care-activity/care-activity.service.ts)
- มติและรายละเอียดการ์ดที่ผู้ใช้ส่งในแชตวันที่ 20 ต.ค. 2026 โดยมติ F03 วันที่ 9 ต.ค. แทนภาพ/ข้อความวันที่ 8 ต.ค.
