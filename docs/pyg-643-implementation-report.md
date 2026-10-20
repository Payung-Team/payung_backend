# PYG-643 · S17 Required Skills — Implementation report

19 ต.ค. 2026 · branch `codex/pyg-643-required-skills` · PR เข้า dev ต้องรอ prerequisite S08 [#125](https://github.com/Payung-Team/payung_backend/pull/125) และ S09 [#135](https://github.com/Payung-Team/payung_backend/pull/135) ผ่าน gate/merge ก่อน

## ผลที่เปลี่ยน

- Pure calculator รับคะแนน ADL รายข้อ, Flags, รหัสบริการ และแถวกติกา ไม่อ่าน DB ไม่รับคะแนนรวม ไม่ใช้ข้อความ booking_tasks ช่วงคะแนนอ่านจาก score_min/score_max เท่านั้น
- ใช้มติ S08 Sammy 9 ต.ค.: ADL null ใช้ 0 เทียบกติกาทักษะ; system unsure เข้าเป็นรหัส Flag ให้ตารางกติกาตัดสิน ไม่มีการสร้างกติกาทักษะใหม่เอง
- ตัดซ้ำตามรหัสทักษะ รวม sources ครบและเรียง ADL/FLAG/SERVICE; เรียงทักษะตาม code
- เขียน bookings.required_skills พร้อมลบ/เขียน booking_required_skills ทั้งชุดใน transaction ของการสร้าง booking หรือบันทึก assessment ผลล้มเหลว rollback ข้อมูลต้นเหตุและผลคำนวณพร้อมกัน
- สร้าง booking ทั้ง REST/จองแทนใช้ writer เดียวกัน; การแก้ assessment คำนวณใหม่ทุก booking ของโปรไฟล์ใบนั้นที่ยังไม่ยืนยัน; confirmBooking คำนวณล่าสุดก่อนเปลี่ยน accepted เป็น confirmed ใน transaction เดียว
- ล็อก care recipient ก่อน booking เหมือนกันทุก writer เพื่อ serialize assessment/การสร้าง/ยืนยัน ไม่ให้คำขอ assessment ที่แข่งกับ confirmation เขียนทับผลที่ยืนยันแล้ว
- confirmedAt หรือสถานะพ้นช่วงที่แก้ไขได้ป้องกันการคำนวณใหม่ รวมงานที่ยืนยันแล้วและถูกยกเลิกภายหลัง; booking เดิมที่ไม่มี careRecipientId ยังคงรายการไม่ทราบ ไม่มีการเดาหรือ backfill
- การอ่านคืนผลที่บันทึก ไม่เรียก calculator; GraphQL field resolvers รวมอ่านหนึ่ง query ต่อ wave ของ request โดยใช้สิทธิ์ root operation เดิม ไม่มี endpoint อ่าน booking ใหม่
- ส่ง field ผ่าน BookingSummary / CaregiverBookingSummary / GroupBookingSummary และ REST BookingRest; CareSkillItem ใช้กติกาล็อกวิชาชีพของ PYG-652 ร่วมกัน
- SKILL_RULE_INVALID ตาม contract: GraphQL execution HTTP 200 + extensions.code/statusCode=422; REST HTTP 422 + code/message กติกาปิดใช้ไม่ถูกนำมาเทียบ
- ไม่มี migration, ไม่มี field รายการทักษะใน input, ไม่แก้ทักษะผู้ดูแล และไม่คำนวณระดับ S16

## จุดเชื่อมและข้อแตกต่างจากข้อเสนอเริ่มต้น

ผู้ใช้เลือกให้ทำ S17 ในจุดที่มีอยู่และเตรียมจุดเชื่อม S15/S16 โดยไม่เพิ่ม API แก้กิจกรรมใหม่:

- `recalculateBookingRequiredSkills(tx, bookingId, transport)` ให้ S15/S16 เรียกหลังเปลี่ยนบริการ/กิจกรรมใน transaction เดียวกัน โดยต้องล็อก care recipient ก่อนเริ่มแก้ booking ไม่เปิด nested transaction
- repo ยังไม่มี API เขียน/แก้กิจกรรม booking และไม่มีตัวคำนวณระดับ S16 จึง **ยังไม่อ้างว่าเชื่อม operation เหล่านั้นแล้ว** ไม่เพิ่ม API นอก contract แทนเจ้าของ S15/S16
- seed S17 อ้างบริการด้วย care activity code เช่น F03 จึงอ่าน code จากกิจกรรมที่ booking บันทึกไว้ด้วย สำหรับ booking serviceType=physiotherapy ที่ยังไม่มี S15 activities ให้เทียบ F03 ตาม R6 ที่ story กำหนดชัด ไม่แปลง medication เป็น injection
- แยก SQL NULL กับ '{}' ด้วย parameterized SQL โดยตรง ไม่ใช้ levelCalculatedAt และไม่เขียนเวลา S16 ทั้งที่ยังไม่คำนวณระดับ แก้คำอธิบายวิธีแปลงใน PYG-641 ให้ตรง implementation และส่ง D3 ให้ DB/BE รับรอง
- snapshot ตรึง code/sources; ชื่อและ lockedProfessions อ้าง metadata กลางปัจจุบันตาม contract ทักษะที่ปิดใช้งานหลังยืนยันยังอ่านได้ ไม่ถูกกรองหาย
- story เดิมกล่าวถึง 14 กติกา แต่ seed PYG-642 ที่มีจริงเป็น 18 แถว (ADL 7 / Flag 5 / Service 6) ทดสอบทุกแถวของ seed ไม่ลดให้เหลือ 14 หรือแก้ข้อมูลกติกาเอง

## ผลทดสอบและ baseline

วัดก่อนและหลังหลัง prisma generate สำเร็จ ชุด baseline รวมงานเดิมทั้งหมดใน checkout ไม่รีเซ็ต staged changes ของผู้ใช้:

| Check | ก่อน | หลัง |
| --- | --- | --- |
| npm test -- --runInBand | 125 suites / 2,380 passed / 0 failed | 127 suites / 2,418 passed / 0 failed |
| npm run test:e2e -- --runInBand (ไม่ตั้ง DB test URL ใน sandbox) | 30 failed / 4 failed suites / 27 skipped | 30 failed / 4 failed suites / 39 skipped |
| tsc --noEmit | 4 errors | 4 errors ข้อความ/ไฟล์/บรรทัดเดิมตรงกัน |
| Postgres ใน Docker | S08/S09 เดิม 14 เคส | S08 8 + S09 6 + S17 12 = 26 passed |
| ESLint ไฟล์ S17 ใหม่และ DB tests | — | ผ่าน ไม่มี error/warning |

ยืนยันชื่อ test ที่ fail ของ full e2e ก่อนและหลังตรงกันทุกข้อ ชุดเดิมมีปัญหา test DI ของ PYG-575/581, HTTP test ใน sandbox ของ PYG-603 และ compile ของ care-log-upload ที่ Express.Multer.File; TypeScript 4 จุดเดิมเป็น profile-photo และ care-log ไม่แก้ baseline เหล่านี้ใน S17

Unit ใหม่ 38 เคส: กติกา seed ทุกแถวและขอบคะแนน, AC6, กายภาพไม่ผูกระดับ, 2/3 แหล่งและหลายข้อ ADL ที่ให้ทักษะเดียวกัน, ลำดับคงที่, null=0, unsure ตามตาราง, inactive/missing skill, ignored inactive rules, รูปแบบและ nullability ของ GraphQL ทั้งสามมุมมอง, batching และ snapshot ไม่สอดคล้อง

Postgres ใหม่ 12 เคส: NULL/[], แก้ assessment หลาย booking, ลบ sources เก่า, hook แก้กิจกรรม/บริการ, F03 และ physiotherapy service type, สร้าง booking จริงและ REST shape, E11 REST rollback, E11 assessment rollback, SQL failure หลังเขียนแล้ว rollback ทั้งสองที่, freeze หลังยืนยัน/เปลี่ยนกติกา/ปิด master และ race assessment vs confirm รวมไม่มี assessment/no fallback

รันทดสอบฐานข้อมูลเฉพาะ localhost database `pyg609_test` ใน container `payung-pyg609-postgres`; ไม่เขียนฐานข้อมูลจริง ไม่รัน migrate dev/db push ไม่มี test ที่ยอมรับ remote DB และ CI ต้องตั้ง test URL เพื่อไม่ skip เงียบ ๆ เพิ่ม S17 ใน workflow ฐานข้อมูลเดิมแล้ว

```sh
PYG609_DATABASE_URL=postgresql://pyg609:pyg609-local-test@127.0.0.1:55409/pyg609_test \
  npm run test:e2e -- --runInBand --runTestsByPath \
  test/pyg609-assessment.e2e-spec.ts \
  test/pyg614-care-group.e2e-spec.ts \
  test/pyg643-required-skills.e2e-spec.ts
```

Generated GraphQL schema มาจาก resolver จริงทั้ง 40 classes ตรวจแล้วว่า field/arguments/enum values เดิมไม่เปลี่ยน ไม่มีการเพิ่ม query ของ S14 ในงาน S17

## ก่อนรวม/deploy

- รอ #125/#135 และ gate ของ PR S17 ไม่มีการ merge/deploy อัตโนมัติ
- ให้เจ้าของ PYG-642/643/646 รีวิว PYG-641 โดยเฉพาะ D1/D2/D3 ที่ยังเป็น draft; การอนุญาตให้ทำงานในแชตไม่ใช่ sign-off แทนทีมทั้งหมด
- ให้เจ้าของกติกายืนยันชุด seed ฉบับใช้งานและความต่าง 14/18 แถว ไม่สร้างกติกาหรือข้อมูล migration ใหม่ในใบนี้
- เจ้าของ S15/S16 เชื่อม writer หลัง operation ของตนมีจริง; ตัวคำนวณระดับและทักษะต้องอยู่ใน transaction เดียวกันและใช้ assessment เดียวกันเมื่อเปิด S16
- ให้ QA PYG-644 ตรวจรับ integration/สิทธิ์กับ environment ที่พร้อม ไม่ถือว่าผ่าน gate จาก unit tests อย่างเดียว
