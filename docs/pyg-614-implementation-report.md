# PYG-614 · S09 backend implementation

17 ต.ค. 2026 · branch `codex/pyg-614-care-group` · ต่อจาก S08 commit `370b48b` / PR #125 ซึ่งยังเป็น draft ตอนเริ่มงาน

## ผลที่เปลี่ยน

- เพิ่ม pure function `classifyCareGroup` ตัวเดียว รับจำนวนเต็ม 0–20 คืน DB code `bedridden` (0–4), `homebound` (5–11), `social` (12–20) คะแนนอื่น throw RangeError ไม่มีค่าเริ่มต้น
- จุดตัด 5 และ 12 เป็น named constants ที่ `src/common/care-group.ts`; S16 PYG-569 สามารถ import ใช้ต่อได้ ยังรอเจ้าของ S16 ยืนยันการใช้ร่วมกัน ไม่ได้อ้างว่าตกลงแล้ว
- AssessmentService คำนวณกลุ่มจากคะแนนรวมที่ S08 ให้มาและเขียนคะแนน/กลุ่มใน upsert transaction เดียวทั้งสร้างและแก้ไข ไม่เปลี่ยนกติกา null ของ S08
- ส่ง `CareRecipientAssessment.careGroup: ElderCareGroup!` ใน submit/read; API enum เป็น SOCIAL/HOMEBOUND/BEDRIDDEN ไม่ใช้ lowercase ของ DB เป็นค่า API
- เพิ่ม nullable careGroup ใน REST profile list/create/update และ GraphQL GroupCareRecipient list/add/update ครบตาม inventory PYG-612
- ไม่มี assessment คืน careGroup=null แม้ mobility_level ระบุติดเตียง; การแก้ชื่อ/รายละเอียดโปรไฟล์ไม่เปลี่ยนกลุ่ม
- ขาอ่านใช้เฉพาะกลุ่มที่เก็บไว้ ไม่มี score/mobility fallback และไม่มี field resolver ที่ query assessment ต่อโปรไฟล์; select relation id/careGroup มากับ profile list เดิม
- ไม่มี input ใหม่ ไม่มี error code ใหม่ ไม่มีการเปิดสุขภาพเพิ่มใน caregiver/admin/public types และไม่มี application log ที่ผูกกลุ่มกับ ID
- อัปเดต contract S09 เป็น v0.2 ยกเลิกข้อเสนอ fallback ขาอ่านตามข้อกำหนด BE ล่าสุด และเพิ่มภาคผนวกแจ้งส่วนขยาย type ให้ PYG-607

## ผลทดสอบ

วัด baseline หลัง prisma generate สำเร็จก่อนเริ่มแก้ เทียบหลังแก้:

| Check | ก่อน | หลัง |
| --- | --- | --- |
| Unit | 97 suites / 1,775 passed / 0 failed | 99 suites / 1,830 passed / 0 failed |
| `tsc --noEmit` | 4 errors | 4 errors ข้อความ/ไฟล์/บรรทัดเดิมตรงกัน |
| Full e2e ไม่ตั้ง test DB vars | 1 suite เดิม compile ไม่ได้ / 21 skipped | suite เดิม 1 แห่ง / 27 skipped รวม DB tests S09 ใหม่ 6 เคส |
| Isolated Postgres | S08 เดิม 8 เคส | S08 8 + S09 6 = 14 passed |

ข้อผิดพลาดเดิมคือ Express.Multer.File ใน profile-photo controller/service และ care-log controller/service; e2e ที่ compile ไม่ได้ยังเป็น care-log-upload.e2e-spec.ts ไม่มี failure เพิ่ม

ทดสอบทุกคะแนน 0–20 และ invalid inputs (ติดลบ, 21, เศษ, NaN/Infinity, string/null/undefined/boolean), ทดสอบแก้ข้ามทั้งสองจุดตัด, ค่า null เมื่อยังไม่ประเมิน, ค่า API/DB mapping, ไม่คำนวณตอนอ่าน, ข้อมูลจาก mobility ที่ขัดกับกลุ่ม, profile response ทั้ง create/update/list, ไม่รับ careGroup จาก GraphQL/REST input และตรวจ schema ว่ากลุ่มอยู่เฉพาะ private profile/assessment types

Postgres ใน Docker ทดสอบคะแนนทุกค่าและค่าที่เก็บจริง, reclassification, null/unsure, จำนวน query ของ list เมื่อมี 1 กับ 10 โปรไฟล์เท่ากัน, SQL error หลังเขียนทำให้คะแนนและกลุ่ม rollback พร้อมกัน และ backfill legacy rows ทุกคะแนนโดย assessedAt ไม่เปลี่ยน พร้อมรัน S08 race/soft-delete tests เดิมทั้งหมด

ใช้ container `payung-pyg609-postgres`, image postgres:16, port 55409, DB pyg609_test เดิมที่ทิ้งได้เท่านั้น ชุดทดสอบปฏิเสธ remote DB และต้องตั้ง test URL ใน CI ไม่ skip เงียบ ๆ ปรับ workflow S08 ให้รันทั้ง pyg609 และ pyg614

```sh
PYG609_DATABASE_URL=postgresql://pyg609:pyg609-local-test@127.0.0.1:55409/pyg609_test npm run test:e2e -- --runInBand 'pyg609|pyg614'
```

ESLint ของ production files ใหม่/ไฟล์ assessment ที่แก้ผ่าน และ generated GraphQL schema diff เพิ่มเฉพาะ enum/fields ของ S09

## Rollout และงาน DB ที่ต้องทำก่อน/หลัง deploy

**ยังไม่ได้รัน backfill บนฐานข้อมูลจริง ไม่ได้ตั้ง NOT NULL และยังไม่ได้ deploy** SQL ที่แนบเป็นเครื่องมือให้เจ้าของ DB รีวิว/รัน:

1. ให้เจ้าของ PYG-607/612 รับรองส่วนขยาย และให้ PR S08 #125 ผ่าน gate/รวมก่อน S09
2. เจ้าของ DB/ผู้ deploy ต้องจัดช่วง rollout ที่ไม่มี S08 writer เก่าบันทึกผลที่ care_group เป็น null แทรกหลัง backfill เช่นพักการบันทึกประเมินระหว่างสลับทุก instance
3. รัน `prisma/backfills/pyg614-care-group.sql` ผ่าน psql พร้อม ON_ERROR_STOP ใน environment ที่จะ deploy เพื่อเติม/แก้กลุ่มจากคะแนน โดยไม่เปลี่ยนเวลา/ผู้ประเมิน สคริปต์อยู่ใน transaction และปฏิเสธคะแนนผิดช่วง
4. รัน `prisma/checks/pyg614-care-group-readiness.sql` ต้องผ่านก่อนเปิด API careGroup! และตรวจซ้ำหลังสลับทุก writer เป็นเวอร์ชันใหม่ หากไม่ผ่าน **หยุด rollout** ไม่ fallback คำนวณบน request และไม่แสดงผล legacy null ว่าไม่เคยประเมิน
5. ตรวจ submit/read และ profile APIs แล้วค่อยเปิดรับบันทึก/FE ที่เลือก field ใหม่
6. **หลัง deploy สำเร็จ** แจ้งเจ้าของ DB PYG-613/Sammy พร้อม environment และผล readiness เพื่อทำ migration ตั้ง care_group NOT NULL ตามมติ ไม่อ้างว่ารันขั้นตอนนี้แล้วจากการเปิด PR

ไม่มี assessment กับ legacy assessment ที่กลุ่มยัง null เป็นคนละกรณี: กรณีแรกคืน null ตาม contract; กรณีหลังเป็น rollout ที่ยังไม่พร้อม ใช้ error ระบบเดิมและต้อง backfill ก่อนเปิดใช้ ไม่เพิ่ม domain error code หรือเดากลุ่มจาก mobility_level

## ประเด็นรับรอง/ส่งต่อที่ยังเหลือ

- Sammy gate และ PYG-607/612 sign-off; ข้อความอังกฤษ/สิทธิ์ผู้ดูแลและแอดมิน/consent ยังเป็นรายการรอตาม contract ไม่มีการขยายสิทธิ์ใน PR นี้
- เจ้าของ S16 PYG-569 ยืนยันการใช้ HOMEBOUND_MIN_ADL_SCORE / SOCIAL_MIN_ADL_SCORE ร่วมกัน
- เจ้าของ S14 PYG-567 รับทราบเมื่อ contract นิ่ง: ใช้ careRecipientId จริง, enum mapping, null/unknown handling และ refresh กลุ่มหลังประเมินใหม่
- เจ้าของ DB PYG-613 รับแจ้งหลัง deploy จริงตามขั้นตอนข้างต้น ขณะนี้ยังไม่มี deployment ที่จะแจ้งว่าสำเร็จ
