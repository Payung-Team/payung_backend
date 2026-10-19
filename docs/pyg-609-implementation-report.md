# PYG-609 · S08 backend implementation

17 ต.ค. 2026 · branch `codex/pyg-609-adl-assessment` · base `dev` at `3eeceb8`

## Behavior

- Private GraphQL `submitCareRecipientAssessment` และ `careRecipientAssessment` ตามร่าง PYG-607; อ่านผลที่ยังไม่มีได้ null เฉพาะผู้มีสิทธิ์
- ตรวจ ADL ครบ 10 รหัส ไม่มีรหัสซ้ำ/อื่น คะแนนจำนวนเต็มในช่วงรายข้อหรือ null; property value หายไม่ใช่ไม่แน่ใจ
- ใช้มติ Sammy 9 ต.ค.: เก็บ null คิดคะแนน 0; นับ null และตั้ง/ถอด system unsure ที่ threshold 3 โดยไม่เขียนลง flags
- ตรวจ Flags 9 รหัส, duplicates, no-special conflict และความรุนแรงสมองเสื่อม; แทนทั้งชุดและล้าง severity เดิมเมื่อถอด dementia
- ล็อกแถวโปรไฟล์และ upsert ใน transaction เดียว เพื่อกัน first-save ซ้ำและการสร้างผลกลับมาระหว่างซ่อนโปรไฟล์
- ตั้ง assessedBy จากผู้ login และ assessedAt/updatedAt จาก server ทุกครั้ง ไม่รับค่าคำนวณ/เวลาจาก client
- เพิ่ม hasAssessment ใน REST care-recipient response และ GraphQL GroupCareRecipient ทั้ง list/create/update โดยไม่แนบคำตอบสุขภาพ
- ซ่อนโปรไฟล์และ deleteMany ผลประเมินใน transaction เดียว; ไม่มีผลประเมินก็ซ่อนได้; cleanup ล้มเหลวต้อง rollback
- Booking ใหม่ทั้ง REST และ GraphQL ตรวจผลของ profile ID ที่จะผูกจริงก่อนเขียน booking/tasks/QR/activity/events ล็อกโปรไฟล์แบบ SHARE กันการซ่อนระหว่างสร้าง
- ไม่เปลี่ยน booking เดิม การแก้ไข/ยกเลิก booking หรือ snapshot ระดับและทักษะของงานเดิม
- ไม่ log คำตอบหรือ Flags และไม่ส่ง database exception ที่อาจมีสุขภาพไปให้ client

## Contract choices requiring FE/BE review

ฐาน PYG-607 ยังเป็น draft ไม่ถือว่ามี sign-off เพียงเพราะมี implementation:

- ใช้ list `{code,value}` บน API และ object ครบ 10 key ใน JSONB; native GraphQL coercion errors ยังคงเป็น framework errors
- Domain validation ใช้ `extensions.code` + `extensions.statusCode: 422` บน GraphQL (execution response HTTP 200); REST booking ใช้ HTTP 422 พร้อม body code ตามร่าง contract
- Orphan `dementiaSevere` true/false โดยไม่มี dementia ถูกปฏิเสธด้วย FLAGS_CONFLICT; ถอด dementia แล้วละ severity หรือส่ง null จะล้างค่าที่เก็บเดิม
- เลือก dementia ต้องส่ง severity boolean; flags=[] ต้องยืนยัน noSpecialConditions=true
- การบันทึกเป็นสิทธิ์เจ้าของโปรไฟล์ (`patientId = actor.id`) ตาม owner-only CRUD เดิม อ่านได้โดยเจ้าของ หรือญาติ ACTIVE ในกลุ่มที่โปรไฟล์ถูกแชร์ เจ้าของยัง ACTIVE และไม่ถอนการเปิดเผยให้กลุ่ม
- CAREGIVER/ADMIN ไม่มีสิทธิ์เพราะ role หรืองานที่รับ; ถ้าเป็นญาติเจ้าของ/สมาชิกกลุ่มจริง ใช้สิทธิ์จากความสัมพันธ์ ไม่เพิ่ม assessment ลง caregiver/public/admin response
- **ไม่มี profile ID = จองไม่ได้**: เส้นทาง name-only/saveAsProfile ระหว่างจองต้องสร้างหรือเลือกโปรไฟล์และประเมินก่อน เส้นทาง memberUserId-only ใช้ได้เฉพาะเมื่อ resolve เป็นโปรไฟล์กลุ่มที่มีผลประเมินแล้ว ไม่ copy ผลของ profile อื่นหรือสร้างผลปลอมให้ผ่าน gate ต้องประสาน FE PYG-610 ก่อนเปิดใช้งาน

## Deferred explicitly by story

- ไม่เพิ่มการเขียน user_consents จนกว่าจะมีมติ consent: ยังขาด consent type/subject/ข้อความและเวอร์ชันที่ผู้ใช้ตอบจริง การส่ง assessment ไม่เท่ากับการให้ consent
- ไม่เพิ่ม catalog query จนกว่าจะเคาะว่า backend เก็บรายการข้อความ; ข้อความอธิบายตัวเลือกรายคะแนน ADL ยังรออาจารย์
- ไม่เพิ่มสิทธิ์ข้อมูลสุขภาพสำหรับผู้ดูแลที่รับงานหรือแอดมิน รอ field matrix ของ story
- ไม่คำนวณ careGroup (PYG-614), ระดับ booking (PYG-569), required skills (PYG-570/643), หรือ cleanup ฟิลด์สุขภาพเดิม (PYG-650)
- รอรีวิว/รับรอง PYG-607 จาก BE/FE และ Sammy gate; ยังไม่ merge/deploy

## Validation evidence

Baseline วัดหลัง `npx prisma generate` สำเร็จก่อนแก้ และวัดซ้ำหลังแก้:

| Check | Before | After |
| --- | --- | --- |
| `npm test -- --runInBand` | 93 suites, 1,708 passed, 0 failed | 97 suites, 1,775 passed, 0 failed |
| `npx tsc --noEmit` | 4 errors | 4 errors ชนิดเดิม/ไฟล์เดิม |
| `npm run test:e2e -- --runInBand` (ไม่ตั้ง DB test vars) | 1 failed suite, 13 skipped tests | 1 failed suiteเดิม, 21 skipped tests รวม DB tests ใหม่ 8 ข้อ |
| PYG-609 isolated Docker/Postgres integration | ไม่มี | 8 passed, 0 failed |

ข้อผิดพลาดเดิมทั้งหมดเกี่ยวกับ `Express.Multer.File`: tsc อยู่ใน profile-photo controller/service และ care-log controller/service; e2e suite เดิม `care-log-upload.e2e-spec.ts` ถูก block โดย type error เดียวกัน ไม่ได้แก้ของนอกขอบเขตเพื่อทำให้ตัวเลขดูดีขึ้น

ชุดใหม่ทดสอบ service-level validation, คะแนนขอบ 0/20, unsure 2/3, E2/E4/E5/E7, ความต่าง omitted/null ผ่าน ValidationPipe จริง, generated GraphQL schema และ execution ของ submit/read, สิทธิ์และ error ที่ไม่เผยสถานะ, hasAssessment, booking ทั้งสอง transport และ no-side-effects เมื่อไม่ผ่าน

Postgres tests ใช้ container `payung-pyg609-postgres`, image `postgres:16`, localhost port 55409, database `pyg609_test`; สร้าง schema จาก Prisma สำหรับ DB ทิ้งได้ ไม่รัน migration บนฐานข้อมูลจริงของโปรเจกต์ ทดสอบ concurrent first saves 10 รอบ, save-vs-hide 10 รอบ, rollback จริงเมื่อเกิด SQL error ระหว่าง cleanup, การคง booking in_progress หลังซ่อน และ gate กับ recipient คนละคน ทุก fixture ถูกลบและปิด pool หลังทดสอบ

เพิ่ม workflow `.github/workflows/pyg609-assessment.yml` ให้ CI เตรียม Postgres service และรัน 8 DB tests จริงโดยไม่ต้องใช้ production secret

ตัวอย่างรันซ้ำเมื่อเตรียม schema ใน DB ทิ้งได้แล้ว:

```sh
PYG609_DATABASE_URL=postgresql://pyg609:pyg609-local-test@127.0.0.1:55409/pyg609_test npm run test:e2e -- --runInBand pyg609
```

Test ปฏิเสธ URL ที่ไม่ใช่ localhost หรือชื่อ DB ไม่ใช่ pyg609_test และใน CI จะ fail หากไม่ตั้ง test URL ไม่ skip เงียบ ๆ

Generated `src/schema.gql` จาก decorator ของ resolver จริง โดยตรวจ diff ว่าเพิ่มเฉพาะ assessment types/operations และ hasAssessment ไม่แก้ชนิด/nullability ของ field เดิม การ generate ในเครื่องข้ามเฉพาะ diagnostics TS2694 เดิม; ผล typecheck เต็มยังรายงาน 4 errors ตามตาราง ไม่ถือว่าผ่าน typecheck
