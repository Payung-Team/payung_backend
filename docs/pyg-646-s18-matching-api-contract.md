# PYG-646 · S18 Matching API contract

20 ต.ค. 2026 · Draft v0.1 เทียบกับ schema จริง · รอเจ้าของ BE PYG-647 / FE PYG-648 รีวิว ไม่อ้างว่า sign-off แล้ว

ใช้ข้อมูลที่บันทึกโดย S16/S17 เท่านั้น ไม่คำนวณระดับหรือ Required Skills ใหม่ใน query นี้ ใช้ CareLevel ของ S02 และ CaregiverProfession ของ S01 ตัวเดิม กายภาพบำบัด F03 จริงได้ ADVANCED ตามมติ 9 ต.ค.; ตัวอย่าง BASIC physiotherapy ของ S18 เป็นกรณีทดสอบความเป็นอิสระของเงื่อนไขวิชาชีพ ไม่ย้อนมติ S16

## Operations

- `eligibleCaregivers(bookingId: ID!): EligibleCaregivers!` — PATIENT ที่เป็นเจ้าของ booking หรือสมาชิก ACTIVE ของกลุ่ม booking ตามสิทธิ์อ่านเดิม คืนเฉพาะคนผ่านครบ 4 เงื่อนไข ไม่มี reasons, จำนวนที่ถูกตัดออก, เอกสาร หรือผู้ดูแลที่ไม่ผ่านใน response
- `bookingMatchReport(bookingId: ID!): BookingMatchReport!` — ADMIN/SUPER_ADMIN เท่านั้น คืนผลรายเงื่อนไขและเหตุผลครบทุกข้อของผู้ดูแลในกลุ่มตั้งต้น ไม่มีรูปเอกสาร เลขใบประกอบฯ หรือข้อมูลผู้สูงอายุในรายงาน
- `selectBookingCaregiver(bookingId: ID!, caregiverId: ID!): BookingCaregiverSelection!` — PATIENT เจ้าของ booking เท่านั้น เช่นเดียวกับ operation ส่วนตัวที่แก้ booking เดิม สิทธิ์อ่าน booking กลุ่มไม่ได้ให้สิทธิ์ผูกผู้ดูแลแทนเจ้าของโดยอัตโนมัติ

เลือกได้เฉพาะ `unmatched`, caregiverId=null และ confirmedAt=null → ตรวจสิทธิ์และข้อมูลปัจจุบันอีกครั้งใน transaction แล้วเขียน caregiverId/status=pending พร้อมกัน สองคำขอเลือกพร้อมกันสำเร็จได้เพียงคำขอเดียว เมื่อไม่ผ่านไม่เปลี่ยน booking และไม่ส่งเหตุผลภายในให้ญาติ

เส้นทางเดิมที่ส่ง caregiverId พร้อมสร้าง booking ต้องตรวจตัวกรองเดียวกันหลังสร้างระดับ/ทักษะใน transaction ถ้าไม่ผ่าน rollback booking, tasks, QR และ snapshot ทั้งหมด ก่อน confirmBooking ตรวจซ้ำหลัง S16/S17 refresh เพื่อไม่ยืนยันคนที่ไม่ผ่านหลังต้นทางเปลี่ยน ส่วน recovery ของ rejected booking ส่ง matches ผ่านตัวกรองนี้ด้วย

การเลือกสำเร็จใช้ event แจ้งคำขอจองเดิมหลัง commit เท่านั้น; การสร้างแบบ unmatched เคยข้ามผู้ดูแลเพราะ caregiverId=null จึงไม่แจ้งซ้ำจากการเลือกที่ล้มเหลว

## Types และที่เก็บเหตุผล

`EligibleCaregivers`: caregivers: [CaregiverSummary!]!, emptyMessage: String, adminContact: MatchingAdminContact

ใช้ CaregiverSummary ของหน้า List จริงใน SearchService คง field เดิมทั้งหมด: id, fullName, avatarUrl, hourlyRate, avgRating, reviewCount, skills, otherSkills, profession, province, district, gender เพิ่ม `careLevel: CareLevel` เป็น nullable เพราะ generic search ยังมีผู้ดูแล legacy ไม่มีระดับ แต่ทุกรายใน eligibleCaregivers ต้องมีระดับที่ถูกต้อง

`MatchingAdminContact`: label: String!, url: String!

เมื่อมีคนผ่าน: emptyMessage=null และ adminContact=null เมื่อไม่มีคนผ่าน: caregivers=[], emptyMessage="ยังไม่มีผู้ดูแลที่ตรงตามความต้องการ กรุณาติดต่อทีมงาน Payung" และช่องทางจาก `MATCHING_ADMIN_CONTACT_URL` (HTTPS ของ LINE Official/ฟอร์มจริง หรือ tel:) ไม่ใส่เบอร์/บัญชีสมมติ ค่าไม่ตั้งหรือไม่ถูกต้องคืน adminContact=null และ **AC7 ยังรอ URL จริง** ผู้ใช้ขอคำแนะนำ ช่องทางที่แนะนำคือ LINE Official ของ Payung ยังไม่ได้ให้บัญชี/URL จริง

`BookingMatchReport`: bookingId: ID!, evaluatedAt: DateTime!, evidenceReferenceDate: DateTime!, persisted: Boolean!, results: [BookingCaregiverMatchResult!]!

`BookingCaregiverMatchResult`: caregiver: MatchReportCaregiver!, passed: Boolean!, checks: MatchChecks!, reasons: [MatchRejection!]!

`MatchReportCaregiver`: id: ID!, fullName: String!, profession: CaregiverProfession!, careLevel: CareLevel

`MatchChecks`: level: Boolean!, skills: Boolean!, profession: Boolean!, evidence: Boolean!

`MatchRejection`: reason: MatchRejectReason!, skillCode: String

MatchRejectReason มี LEVEL_NOT_SET, LEVEL_TOO_LOW, SKILL_MISSING, PROFESSION_MISMATCH, EVIDENCE_NOT_APPROVED, EVIDENCE_EXPIRED ระดับไม่ผ่านไม่มี skillCode; เหตุผลอีกสี่แบบระบุรหัสทักษะที่เกี่ยวข้อง ไม่ใช้ชื่อไทยเทียบรหัส เรียงเหตุผลตามระดับ → ทักษะ → วิชาชีพ → หลักฐาน ภายในเงื่อนไขเรียง skillCode ไม่มีเหตุผลซ้ำ

**มติผู้ใช้: ยังไม่เคาะที่เก็บเหตุผล** รายงาน v0.1 เป็นผลสด ณ evaluatedAt, persisted=false เสมอ ไม่ใช่ผลย้อนหลังจากครั้งที่ญาติเห็น และไม่ใช่การปิด AC6 ไม่มีการใช้ log ทั่วไปแทนที่เก็บผล ไม่มีตาราง/Prisma model/migration ใหม่ ต้องให้เจ้าของ PYG-571/646 กับ Sammy เคาะและมีการ์ด DB/gate ถ้าจะบันทึกถาวร

## ข้อมูลและกติกาที่ใช้

- กลุ่มตั้งต้นใช้เงื่อนไขของ List จริงร่วมกัน: is_searchable=true, kyc_status=verified และมี active availability อย่างน้อยหนึ่ง slot คนที่อยู่นอกกลุ่มนี้ไม่อยู่ใน report และไม่สร้างเหตุผล S18
- กรองก่อน pagination/limit เดิม ไม่มีการตัดคนผ่านเพราะคนไม่ผ่านกินโควตาหน้า คืนทุกคนผ่านโดยรักษาการเรียงของ List เดิม เพิ่มเพียง id เป็นตัวตัดสินเมื่อคะแนนเท่ากันสำหรับ pagination ที่คงที่ ไม่เพิ่มคะแนนจัดอันดับ S18
- required_level ต้องเป็น CareLevel ที่รู้จัก, required_skills ต้องไม่เป็น SQL NULL และมี level_calculated_at ใช้ SQL อ่าน scalar list เพื่อแยก NULL จาก [] ที่ Prisma แปลงเหมือนกัน
- Required Skills=[] หมายถึงคำนวณแล้วไม่มีทักษะ: ทักษะ/วิชาชีพ/หลักฐานผ่าน ตรวจระดับต่อไป ระดับผู้ดูแล null/ไม่รู้จัก → LEVEL_NOT_SET ไม่ตี BASIC
- ทักษะและ lockedProfessions อ่านผ่าน snapshot reader ของ S17 ซึ่งใช้ metadata กลาง `care-skill.constants.ts` ที่เดียว ไม่คัดลอกรายการล็อกใน S18 ระหว่างยังไม่มี enum/หลักฐานผู้ช่วยพยาบาล ไม่เปิดให้ผู้ดูแลทั่วไปผ่าน 4 ทักษะที่ล็อกพยาบาล
- หลักฐานใช้ S03 professional_license ที่ผูกกับ caregiver และ user เดียวกัน สถานะ approved และมีวันหมดอายุที่ถูกต้อง หลายใบ: ใบอนุมัติที่ยังใช้ได้ยังใช้ต่อได้ระหว่างรอใบต่ออายุ ไม่ใช้เอกสารของ user อื่น
- ใช้ caregivers.profession ที่อนุมัติแล้ว ไม่ใช้วิชาชีพในคำขอ pending เอกสารที่ผูกกับคำขอวิชาชีพอื่นไม่ถือเป็นหลักฐานของวิชาชีพปัจจุบัน หลังเปลี่ยนวิชาชีพไม่ใช้เอกสารเก่าที่ไม่มีความเชื่อมโยงก่อนการอนุมัตินั้น S03 ยังไม่มี profession ต่อเอกสาร; ไม่สร้างคอลัมน์เองใน S18
- **E8 ผู้ใช้ยืนยัน: เทียบวันให้บริการ** ใช้เที่ยงคืนต้นวัน booking_date ที่ Asia/Bangkok เป็น referenceDate วันหมดอายุ S03 เก็บสิ้นวัน ดังนั้นหมดอายุวันก่อนบริการไม่ผ่าน และสิ้นวันเดียวกับวันบริการผ่าน ไม่เชื่อวันที่ client ส่งให้ตัวกรอง และไม่ใช้นาฬิกาภายใน pure function
- ตรวจทั้ง 4 เงื่อนไขเสมอ ความสามารถด้านอื่นไม่ชดเชยกัน หลักฐานต้องตรงวิชาชีพที่ทักษะอนุญาตด้วย จึงอาจได้ PROFESSION_MISMATCH และ EVIDENCE_NOT_APPROVED พร้อมกัน ทักษะไม่ล็อกไม่ตรวจใบประกอบฯ เพิ่มเอง
- Queries ใช้ RepeatableRead เพื่อให้ booking/ทักษะ/ผู้ดูแล/หลักฐานและรายการ public มาจาก snapshot เดียวกัน ไม่มี cache ข้ามคำขอ การเลือกใช้ lock recipient → booking → caregiver และล็อกหลักฐานก่อนตรวจ/เขียน; ยังตรวจตารางว่างตามวัน/ช่วงและเวลานัดซ้ำตามกลไกเดิม
- Generic search ที่ไม่ผูก booking ยังคงเป็น browse เดิม; การเปลี่ยน FE ให้เลือกหลังสร้าง booking อยู่ที่ PYG-648 API ใหม่รับ bookingId ที่สร้างแล้ว เส้นทางเดิมเลือกก่อนสร้างยังถูกตรวจอีกครั้งฝั่ง server

## Errors

- BOOKING_NOT_MATCHABLE: ยังไม่คำนวณ/ไม่รู้จักระดับ หรือ SQL NULL Required Skills ไม่คืนผู้ดูแลทุกคน
- CAREGIVER_NOT_ELIGIBLE: คนที่เลือกไม่ผ่านข้อมูลล่าสุด รวมการเปลี่ยนระดับ/ทักษะ/วิชาชีพ/หลักฐาน หรือไม่อยู่ในกลุ่ม public/ตารางว่างตามเดิม ไม่แนบ reasons ภายใน
- BOOKING_NOT_SELECTABLE: ไม่ใช่ unmatched ที่ยังไม่ผูกผู้ดูแล หรือยืนยันแล้ว ไม่มีผลเขียนบางส่วน
- สิทธิ์ใช้ Unauthorized/Forbidden/NotFound ของ repo ตาม guard และ booking access เดิม ไม่เพิ่ม code สิทธิ์ใหม่

GraphQL domain errors ใช้ errors[].extensions.code และ statusCode=422 บน HTTP 200 ตาม repo; REST create/recover แปลง domain error เป็น HTTP 422 ไม่เป็น 500 และไม่เปลี่ยน validation/auth errors เป็น business error

## ตัวอย่าง

### Elder: ผู้ดูแลผ่าน

```graphql
query Eligible($bookingId: ID!) {
  eligibleCaregivers(bookingId: $bookingId) {
    caregivers { id fullName profession careLevel skills }
    emptyMessage
    adminContact { label url }
  }
}
```

Variables: `{"bookingId":"11111111-1111-4111-8111-111111111111"}`

```json
{"data":{"eligibleCaregivers":{"caregivers":[{"id":"22222222-2222-4222-8222-222222222222","fullName":"ผู้ดูแลตัวอย่าง","profession":"physiotherapist","careLevel":"ADVANCED","skills":["physiotherapy"]}],"emptyMessage":null,"adminContact":null}}}
```

### Elder: ไม่มีคนผ่าน และยังไม่ตั้งช่องทางจริง

ใช้ query เดิม ไม่เป็น error ไม่มีจำนวนคนที่ถูกตัดออก:

```json
{"data":{"eligibleCaregivers":{"caregivers":[],"emptyMessage":"ยังไม่มีผู้ดูแลที่ตรงตามความต้องการ กรุณาติดต่อทีมงาน Payung","adminContact":null}}}
```

เมื่อตั้ง URL จริง adminContact เป็น {label,url} ตาม type ไม่ต้องเปลี่ยน FE query แต่ยังไม่อ้างว่าตั้งแล้ว

### Admin: ผลสดครบทุกเงื่อนไข

```graphql
query Report($bookingId: ID!) {
  bookingMatchReport(bookingId: $bookingId) {
    bookingId evaluatedAt evidenceReferenceDate persisted
    results {
      caregiver { id fullName profession careLevel }
      passed checks { level skills profession evidence }
      reasons { reason skillCode }
    }
  }
}
```

```json
{"data":{"bookingMatchReport":{"bookingId":"11111111-1111-4111-8111-111111111111","evaluatedAt":"2026-10-20T08:00:00.000Z","evidenceReferenceDate":"2026-10-24T17:00:00.000Z","persisted":false,"results":[{"caregiver":{"id":"33333333-3333-4333-8333-333333333333","fullName":"พยาบาลตัวอย่าง","profession":"nurse","careLevel":"BASIC"},"passed":false,"checks":{"level":false,"skills":false,"profession":false,"evidence":false},"reasons":[{"reason":"LEVEL_TOO_LOW","skillCode":null},{"reason":"SKILL_MISSING","skillCode":"physiotherapy"},{"reason":"PROFESSION_MISMATCH","skillCode":"physiotherapy"},{"reason":"EVIDENCE_NOT_APPROVED","skillCode":"physiotherapy"}]}]}}}
```

### เลือกผู้ดูแล

```graphql
mutation Select($bookingId: ID!, $caregiverId: ID!) {
  selectBookingCaregiver(bookingId: $bookingId, caregiverId: $caregiverId) {
    bookingId caregiverId status
  }
}
```

```json
{"data":{"selectBookingCaregiver":{"bookingId":"11111111-1111-4111-8111-111111111111","caregiverId":"22222222-2222-4222-8222-222222222222","status":"pending"}}}
```

ถ้าข้อมูลเปลี่ยนแล้วไม่ผ่าน ส่ง code โดยไม่ส่งรายชื่อ/เหตุผลภายใน:

```json
{"data":null,"errors":[{"message":"ผู้ดูแลรายนี้ไม่สามารถรับ booking นี้ได้ กรุณาเลือกใหม่","extensions":{"code":"CAREGIVER_NOT_ELIGIBLE","statusCode":422}}]}
```

ผลตรวจโค้ดและ baseline: [PYG-647 validation / review](pyg-647-s18-matching-validation.md)

## Review / ข้อค้างก่อนปิดการ์ด

- ผู้ใช้ยืนยัน E8 ใช้วันให้บริการและตรวจซ้ำตอนเลือกแล้ว; AC6 ยังไม่เคาะที่เก็บ ให้ PYG-571/646 + Sammy ตัดสิน ไม่อ้างว่า live report คือบันทึกประวัติ
- AC7 รอ URL/เบอร์ติดต่อจริงของ Payung และผู้ตั้งค่า deploy; แนวที่แนะนำ LINE Official ไม่สร้างบัญชี/ส่งข้อความแทนทีม
- BE PYG-647 และ FE PYG-648 รับรอง operation names, สิทธิ์เลือกเฉพาะเจ้าของ, ป้ายระดับใน public List, รูป report และ empty-state/contact
- QA PYG-649 ส่งตารางฉบับรับรองมาทวนกับ tests; ทดสอบครอบคลุมเคสที่ส่งในแชตและตารางระดับ 9 คู่แล้ว ไม่อ้างว่ามีเอกสาร QA แยกที่ยังไม่ได้รับ
- ไม่มีการ์ด DB/migration เพิ่มในงานนี้ การเปิด PR ไม่เท่ากับ human gate ผ่าน
