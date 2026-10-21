# PYG-611 · QA แบบประเมิน ADL และ Flags (S08 · PYG-563)

- การ์ด: PYG-611 (QA) · Story: PYG-563 · ขึ้นกับ: PYG-607 (contract), PYG-608 (DB), PYG-609 (BE · #125), PYG-610 (FE)
- Commit ที่ทดสอบ: `origin/dev` @ `fb20b70`
- รัน: 2026-10-20 · Created By / Execute By: Wasan. R
- Spec: `test/pyg611-assessment.e2e-spec.ts` · harness: `test/support/qa-e2e.ts`
- **ผล: PASS 32 TC · FAIL 1 TC (3 กรณีย่อย → bug PYG-666 · Low) · BLOCKED 1 · NOT RUN (หน้าจอ) 5**
- **รันซ้ำ 2026-10-21 หลัง PYG-666 แก้ (#156): PYG-563_33 PASS 3/3 → PASS 33 TC · FAIL 0**

## 0. ต้นทางของ expected

- **คะแนน:** คำนวณมือจากตาราง Barthel ADL ฉบับไทย 10 ข้อ เต็ม 20 (feeding 2, grooming 1, transfers 3, toilet_use 2, mobility 3, dressing 2, stairs 2, bathing 1, bowels 2, bladder 2) — ไม่อ่านจากโค้ด
- **ไม่แน่ใจ = null นับ 0** และ `unsureCount ≥ 3` → `hasUnsureFlag`: มติ Sammy 9 ต.ค. 2026 (contract PYG-607 §1)
- เคสที่ระบุ **(D4)** = กติกาที่ contract ยังเป็น "ข้อเสนอรอรับรอง" (บังคับยืนยันไม่มีเงื่อนไขเมื่อไม่เลือก Flag · บังคับระบุความรุนแรงเมื่อเลือกสมองเสื่อม) — ผลตรงกับข้อเสนอ แต่ต้องรอทีมรับรอง

## 1. Test case sheet

ทุกเคส: 1. ญาติ (บัญชีทดสอบ) + โปรไฟล์ผู้สูงอายุที่ยังไม่มีแบบประเมิน · 2. เรียก API · 3. ตรวจ response และแถวใน DB · expected 1:1

### AC1 · ต้องตอบครบ
| TC | Verify that… | ผล |
|---|---|---|
| PYG-563_01 | ขาดข้อ bladder → `ASSESSMENT_INCOMPLETE` `missingAnswerCodes: [bladder]` · ไม่มีแถวถูกเขียน | PASS |
| PYG-563_02 | ข้อที่ไม่มี property `value` ถือว่ายังไม่ตอบ (ไม่ใช่ "ไม่แน่ใจ") → `INCOMPLETE` `[stairs]` | PASS |
| — | หน้าจอ: ขั้นแบบประเมินต่อจาก onboarding · ข้ามข้อแล้วไปต่อไม่ได้ | NOT RUN (FE) |

### AC2 · คะแนน
| TC | ชุดคำตอบ → คาด (คำนวณมือ) | ผล |
|---|---|---|
| PYG-563_03a | ทุกข้อ 0 → 0 | PASS |
| _03b | ทุกข้อเต็ม → 20 | PASS |
| _03c | 1+1+2+1+2+1+1+0+1+1 → 11 | PASS |
| _03d | ตัวอย่าง contract (2 ข้อไม่แน่ใจ) → 10, unsure 2 | PASS — DB เก็บ null ตามจริง ไม่แทนด้วย 0 |
| PYG-563_04 | client ส่ง `adlTotalScore` / `unsureCount` / `hasUnsureFlag` เอง → schema ปฏิเสธ `BAD_USER_INPUT` ไม่มีแถว | PASS |

### AC3 · Flags
| TC | Verify that… | ผล |
|---|---|---|
| PYG-563_05 | Flag 1 ข้อ / หลายข้อบันทึกครบ (คืนตามลำดับตาราง contract) | PASS |
| PYG-563_06 | "ไม่มีเงื่อนไขพิเศษ" อย่างเดียวบันทึกได้ | PASS |
| PYG-563_07 ×3 | Flag นอกรายการ / `unsure` (Flag ระบบ) / Flag ซ้ำ → `ASSESSMENT_FLAG_INVALID` ไม่มีแถว | PASS 3/3 |
| PYG-563_08 (D4) | ไม่เลือก Flag และไม่ยืนยัน "ไม่มีเงื่อนไข" → `INCOMPLETE` | PASS |

### AC4
| TC | Verify that… | ผล |
|---|---|---|
| PYG-563_09 | "ไม่มีเงื่อนไขพิเศษ" + Flag → `ASSESSMENT_FLAGS_CONFLICT` ไม่มีแถว | PASS |
| — | หน้าจอไม่ให้เลือกพร้อมกันทั้งสองลำดับการกด | NOT RUN (FE) |

### AC5 · ไม่แน่ใจ
| TC | Verify that… | ผล |
|---|---|---|
| PYG-563_10 | ทุกข้อรับ "ไม่แน่ใจ" — ตอบไม่แน่ใจ 10 ข้อ = แบบประเมินสมบูรณ์ คะแนน 0 unsure 10 มี Flag | PASS |
| PYG-563_11 ×3 | ไม่แน่ใจ 2 → ไม่มี Flag · 3 → มี · 5 → มี (และไม่ใส่ `unsure` ใน `flags`) | PASS 3/3 |
| PYG-563_12 | แก้จาก 3 เหลือ 2 ข้อ → Flag ถูกถอด | PASS |

### AC6 · ความรุนแรงสมองเสื่อม
| TC | Verify that… | ผล |
|---|---|---|
| PYG-563_13 ×2 | สมองเสื่อม + รุนแรง true / false บันทึกถูก | PASS 2/2 |
| PYG-563_14 (D4) | สมองเสื่อมแต่ไม่ระบุความรุนแรง → `INCOMPLETE` `fields: [dementiaSevere]` | PASS |
| PYG-563_15 ×2 | ไม่มีสมองเสื่อมแต่ส่งความรุนแรง true / false → `FLAGS_CONFLICT` | PASS 2/2 |
| PYG-563_16 | ยกเลิก Flag สมองเสื่อม → ความรุนแรงถูกล้างเป็น null (API + DB) | PASS |

### AC7
| — | ข้อความ "ADL ประเมินโดยญาติ ไม่ใช่การวินิจฉัย" TH/EN ตาม Figma | NOT RUN (FE) |
|---|---|---|

### AC8 · แก้ไข
| TC | Verify that… | ผล |
|---|---|---|
| PYG-563_17 | อ่านแล้วได้คำตอบเดิมครบ 10 ข้อตามลำดับ · แก้แล้วคะแนน/Flags เปลี่ยน · `assessedAt` ใหม่กว่าเดิม · DB ยังมี 1 แถว | PASS |
| PYG-563_18 | ส่ง 2 ครั้งพร้อมกัน → ไม่เกิดแถวซ้ำ | PASS |

### AC9 · ด่านจอง
| TC | Verify that… | ผล |
|---|---|---|
| PYG-563_19 | REST จองให้ผู้สูงอายุที่ไม่มีแบบประเมิน → 422 `ASSESSMENT_REQUIRED` ไม่มี booking | PASS |
| PYG-563_20 | จองแทนในกลุ่ม (GraphQL) → `ASSESSMENT_REQUIRED` ไม่มี booking | PASS |
| PYG-563_21 | มีแบบประเมิน → จองได้ 201 | PASS |
| — | หน้าจอกันไม่ให้ไปต่อ | NOT RUN (FE) |

### AC10 · บัญชีเดิม
| TC | Verify that… | ผล |
|---|---|---|
| PYG-563_22 | โปรไฟล์เดิม `hasAssessment=false` (REST `GET /patient/care-recipients`) · API อื่นใช้ได้ไม่ถูกบังคับ · จองไม่ได้ → ประเมิน → `true` → จองได้ | PASS |
| PYG-563_23 | โปรไฟล์ในกลุ่ม (`groupCareRecipients`) มี `hasAssessment` | PASS |
| — | หน้าจอพาไปประเมินแล้วกลับมาจองต่อ | NOT RUN (FE) |

### Edge cases
| TC | Verify that… | ผล |
|---|---|---|
| PYG-563_24 (E1) | ออกกลางทาง (ส่ง 5 ข้อ) → ไม่บันทึกอะไร (v1 ไม่มี draft) และยังจองไม่ได้ | PASS |
| PYG-563_25 (E2) | "ไม่มีเงื่อนไขพิเศษ" + ไม่แน่ใจ 3 ข้อ → บันทึกได้ มี Flag ไม่แน่ใจ | PASS |
| PYG-563_26 ×4 (E7) | ค่านอกตัวเลือก (grooming=2) / รหัสข้อไม่มี / ซ้ำ / ตัวพิมพ์ผิด → `ASSESSMENT_ANSWER_INVALID` · ผลเดิมไม่ถูกแตะ (ไม่มีการเขียนบางส่วน) | PASS 4/4 |
| **PYG-563_33 ×3 (E7)** | **รหัสข้อไม่มี / ซ้ำ / ตัวพิมพ์ผิด ระบุรหัสที่ผิดใน metadata (`invalidAnswerCodes` / `duplicateAnswerCodes` ตาม contract §8)** | ~~FAIL → PYG-666~~ **PASS (รันซ้ำหลัง #156)** — เดิม extensions มีแค่ `code`/`statusCode` · เปลี่ยน `it.failing` → `it` แล้ว |
| PYG-563_27 (E9) | ผู้สูงอายุ 2 คน ประเมินแล้ว 1 → จองได้เฉพาะคนที่ประเมิน | PASS |
| PYG-563_28 (E10) | booking ที่สร้างก่อนฟีเจอร์ (ผู้สูงอายุไม่มีแบบประเมิน) ยังเปิดดูได้ | PASS |
| PYG-563_29 | ญาติ A อ่าน/บันทึกของผู้สูงอายุญาติ B → `ASSESSMENT_ACCESS_DENIED` ไม่หลุดข้อมูล ผลเดิมไม่เปลี่ยน · id ไม่มีอยู่ / ไม่ใช่ UUID ได้ error และข้อความเดียวกัน | PASS |
| PYG-563_30 | role ผู้ดูแลอ่าน/บันทึก → `ASSESSMENT_ACCESS_DENIED` | PASS |
| PYG-563_31 | ไม่ล็อกอิน → `UNAUTHENTICATED` | PASS |
| PYG-563_32 | ไม่มี type อื่นใน schema (public, list, profile, booking) ที่มี field ของแบบประเมิน | PASS |
| — | Consent ของแบบประเมิน | **BLOCKED** — story/contract ยังไม่เคาะว่าต้องขอความยินยอมแยก |
| — | หน้าจอมือถือ / Flags ยาวไม่ล้น | NOT RUN (FE) |

## 2. สรุป

| | จำนวน |
|---|---|
| PASS | 32 TC (44 รอบรวมค่าย่อย) — 2 เคสเป็นกติกา (D4) ที่รอรับรอง |
| FAIL | 1 TC (3 กรณี) → **PYG-666** (Low · ไม่บอกรหัสข้อที่ผิดใน error) |
| BLOCKED | 1 (consent) |
| NOT RUN | 5 (หน้าจอ: AC1 / AC4 / AC7 / AC9-AC10 บนจอ / มือถือ) |

## 3. Production (อ่านอย่างเดียว · 2026-10-20) — query ของ PYG-608

| ตรวจ | ผล |
|---|---|
| คอลัมน์ | ครบ 14 รวม `care_group` (S09) |
| constraint | `recipient_key` (unique ต่อผู้สูงอายุ) · `score_check` · `unsure_check` · `none_check` · `care_group_check` · FK 2 ตัว |
| RLS | เปิด · ไม่มี policy (BE อ่านผ่าน Prisma เท่านั้น) |
| ข้อมูล | 3 แถว · ผู้สูงอายุซ้ำ 0 · คะแนน/unsure นอกช่วง 0 |

## 4. รันซ้ำ / harness

```bash
QA_DATABASE_URL=postgresql://postgres:qa@127.0.0.1:5436/<db> npm run test:e2e -- --runInBand test/pyg611
```
- PYG-611 เดี่ยว 5 รอบ: 47/47 ทุกรอบ (รวม `it.failing` 3 ที่ "ผ่าน" เพราะบั๊กยังอยู่)
- 5 ชุด QA ใน DB เดียว (แบบ CI): ก่อนแก้ harness ได้ `Parse Error: Expected HTTP/` แบบสุ่ม 2 ใน 3 รอบ (supertest เปิด/ปิด port ชั่วคราวทุก request เมื่อแอปไม่ได้ listen) → harness ให้แอป `listen(0)` ครั้งเดียว · หลังแก้ 3 รอบบน DB ใหม่: **201/201 ทุกรอบ**
- PYG-666 แก้แล้ว (#156): เปลี่ยน `it.failing` → `it` ใน `PYG-563_33` แล้ว
