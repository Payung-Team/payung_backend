# PYG-615 · QA จัดกลุ่มผู้สูงอายุ (S09 · PYG-564)

- การ์ด: PYG-615 (QA) · Story: PYG-564 · ขึ้นกับ: PYG-612 (contract), PYG-613 (DB), PYG-614 (BE · #135 + backfill 20 ต.ค.), S08
- Commit ที่ทดสอบ: `origin/dev` @ `fb20b70`
- รัน: 2026-10-20 · Created By / Execute By: Wasan. R
- Spec: `test/pyg615-care-group.e2e-spec.ts` · harness: `test/support/qa-e2e.ts`
- **ผล: PASS 16 TC (31 รอบรวมค่าย่อย) · FAIL 0 · BLOCKED 0 · ไม่มี bug card**

## 0. ต้นทางและข้อตกลง

- กลุ่มที่คาดไว้: ตาราง AC1–AC4 ของการ์ด (12–20 ติดสังคม · 5–11 ติดบ้าน · 0–4 ติดเตียง)
- คะแนนสร้างผ่าน `submitCareRecipientAssessment` จริงทุกเคส **ไม่เขียน `adl_total_score` / `care_group` ตรง** (ตามข้อควรระวังของการ์ด) ชุดคำตอบเติมคะแนนตามลำดับข้อ Barthel (feeding 2 → grooming 1 → transfers 3 → toilet_use 2 → mobility 3 → dressing 2 → stairs 2 → bathing 1 → bowels 2 → bladder 2) จนครบยอด และทุกเคสตรวจว่าคะแนนที่บันทึก = ยอดที่ตั้งใจ
- **"ไม่แน่ใจ":** การ์ดให้ Blocked จนกว่า S08 เคาะ — S08 เคาะแล้ว (null = 0 · มติ Sammy 9 ต.ค. · contract S09 §2) จึงทดสอบใน _15/_16
- โปรไฟล์สร้างผ่าน REST `POST /api/v1/patient/care-recipients` จริง

## 1. Test case sheet

### AC1–AC4 · กลุ่มตามคะแนน
| TC | คะแนน → กลุ่ม | ผล |
|---|---|---|
| PYG-564_01 ×9 | 20 / 16 / 12 → ติดสังคม · 11 / 8 / 5 → ติดบ้าน · 4 / 2 / 0 → ติดเตียง — response ของ submit, REST โปรไฟล์ และ DB ตรงกันทุกค่า | PASS 9/9 |

### AC5 · แก้ไข
| TC | แก้จาก → ไป | ผล |
|---|---|---|
| PYG-564_02 ×5 | 12→11 ติดบ้าน · 5→4 ติดเตียง · 4→12 ติดสังคม · 16→13 คงติดสังคม · 8→6 คงติดบ้าน — อ่านทันทีหลังบันทึก (REST + GraphQL) ได้กลุ่มใหม่ | PASS 5/5 |

### AC6 · ทุก operation
| TC | Verify that… | ผล |
|---|---|---|
| PYG-564_03 | REST POST (null ก่อนประเมิน) · GET · PUT (แก้ชื่อเล่น/supportLevel แล้วกลุ่มคงเดิม) มี `careGroup` เสมอ | PASS |
| PYG-564_04 | `addGroupCareRecipient` (null) · `groupCareRecipients` ครบ 3 กลุ่ม · `updateGroupCareRecipient` คงกลุ่มเดิม | PASS |
| PYG-564_05 | `careRecipientAssessment` มี `careGroup` | PASS |

### AC7 · ยังไม่มีแบบประเมิน
| TC | Verify that… | ผล |
|---|---|---|
| PYG-564_06 ×4 | `mobility_level` ทั้ง 4 ค่า (ช่วยตัวเองได้ดี / พยุงเดิน / ติดเตียง / รถเข็น) ไม่มีแบบประเมิน → `careGroup null` · อ่านผลประเมินได้ `null` ไม่ error | PASS 4/4 |

### Edge cases
| TC | Verify that… | ผล |
|---|---|---|
| E6 | แถวผลประเมินก่อน migration มีกลุ่มถูกหลัง backfill | PASS — production (อ่านอย่างเดียว): 3 แถว กลุ่มว่าง 0 ไม่ตรงคะแนน 0 (backfill รัน 20 ต.ค. ตาม `prisma/backfills/pyg614-care-group.sql` + readiness check ผ่าน) |
| PYG-564_07 (E7) | `mobility_level` = ติดเตียง แต่ ADL 20 → ติดสังคม · `mobility_level` ไม่ถูกแก้ | PASS |
| PYG-564_08 | แก้เฉพาะ Flags คะแนนเท่าเดิม → กลุ่มคงเดิม | PASS |
| PYG-564_09 | ส่ง `careGroup` ใน input แบบประเมิน → `BAD_USER_INPUT` · ใน REST PUT → 400 · กลุ่มยังมาจากคะแนน | PASS |
| PYG-564_10 | บัญชีเดียว 2 ผู้สูงอายุคนละกลุ่ม ไม่สลับกัน | PASS |
| PYG-564_11 | ญาติ A ไม่เห็นโปรไฟล์ของญาติ B ในรายการ · อ่านผลประเมิน → `ASSESSMENT_ACCESS_DENIED` ไม่หลุดกลุ่ม | PASS |
| PYG-564_12 | role ผู้ดูแล: อ่านผลประเมิน → denied · `CaregiverBookingSummary` ไม่มี field `careGroup` | PASS |
| PYG-564_13 | ใน schema มี `careGroup` เฉพาะ `CareRecipientAssessment` และ `GroupCareRecipient` (ไม่อยู่ใน type สาธารณะ/รายการผู้ดูแล/booking) · ไม่ล็อกอิน GraphQL `UNAUTHENTICATED` / REST 401 | PASS |
| PYG-564_14 | client ที่ไม่ขอ `careGroup` ยังได้รายการโปรไฟล์ตามเดิม (regression) | PASS |
| PYG-564_15 | "ไม่แน่ใจ" ทุกข้อ (null = 0) → คะแนน 0 → ติดเตียง ไม่ใช่ null | PASS |
| PYG-564_16 | ค่าขอบ 11/12 กับ "ไม่แน่ใจ": ชุด 12 แล้วตอบไม่แน่ใจข้อที่ได้ 1 → 11 → ติดบ้าน | PASS |

## 2. สรุป

| | จำนวน |
|---|---|
| PASS | 16 TC (31 รอบ) + E6 บน production |
| FAIL / BLOCKED | 0 / 0 |
| ยังไม่ได้ทดสอบ | สิทธิ์ของผู้ดูแล/แอดมินที่ "รอเคาะ" ใน contract S09 §5 — ทดสอบสถานะปัจจุบัน (ไม่ได้รับ) แล้ว ถ้าเคาะเปิดให้เห็นต้องเพิ่มเคส |

## 3. รันซ้ำ

```bash
QA_DATABASE_URL=postgresql://postgres:qa@127.0.0.1:5436/<db> npm run test:e2e -- --runInBand test/pyg615
```
DB ใหม่: 31/31 · 6 ชุด QA ใน DB เดียว (แบบ CI) 2 รอบ: 232/232 · harness เพิ่ม `rest().put`
