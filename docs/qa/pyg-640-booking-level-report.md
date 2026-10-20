# PYG-640 · QA ระดับ booking (S16 · PYG-569)

- การ์ด: PYG-640 (QA) · Story: PYG-569 · ขึ้นกับ: PYG-637 (contract), PYG-638 (DB · seed กติกา + F03), PYG-639 (BE · #147)
- Commit ที่ทดสอบ: `origin/dev` @ `fb20b70` (รวม #147)
- รัน: 2026-10-20 · Created By / Execute By: Wasan. R
- Spec: `test/pyg640-booking-level.e2e-spec.ts` · harness: `test/support/qa-e2e.ts` · T-01: `test/support/t01-catalog.ts`
- **ผล: PASS 23 TC (39 รอบรวมค่าย่อย) · FAIL 0 · BLOCKED 5 · ไม่มี bug card**

## 0. ต้นทางของ expected — อ่านก่อน

| เรื่อง | ต้นทางที่ใช้ |
|---|---|
| ADL 0/4/5/11/12/20 | ตารางค่าขอบในการ์ด |
| สมองเสื่อมระบุรุนแรง → สูง | AC3 ของการ์ด |
| ระดับของบริการ | `care_level` ของกิจกรรมตาม **T-01 + PYG-651** (CSV ต้นทาง ไม่ใช่ DB) — S16 ใช้ค่านี้เมื่อไม่มี override |
| **กายภาพบำบัด (F03) → สูง** | **มติ Sammy 9 ต.ค.** (contract PYG-637 §1 · migration `20261009010000_pyg638_f03_level_advanced`) — **แทน** แถว "กายภาพบำบัดไม่ดันระดับ" ในการ์ด |
| ระดับของ Flag อื่น (เบาหวาน, ฉีดยา, ไม่แน่ใจ ฯลฯ) | infographic ยังไม่มี → เคสที่ใช้ระบุ **(seed)** = ตรวจกลไก max/no-effect ไม่รับรองว่าระดับของ Flag นั้นถูกตามอาจารย์ |

**การ์ดต้องแก้ตามมติ F03:** แถว "ADL 12 + กายภาพอย่างเดียว = ต้น", "ADL 5 + กายภาพ = กลาง", "ADL 12 + กายภาพ + บริการกลาง = กลาง" และ AC4 "จองเฉพาะกายภาพ เกณฑ์ที่ 3 ไม่มีผล" ใช้กติกา 8 ต.ค. — ผลจริง (ตามมติ 9 ต.ค.) = **สูง** ทั้งหมด เทสยึดมติใหม่

## 1. Test case sheet

ทุกเคส: 1. สร้างผู้รับบริการ + แบบประเมินผ่าน API · 2. จอง (REST, ไม่ระบุผู้ดูแล) · 3. ตรวจ `requiredLevel` + `levelBreakdown` ใน response · expected 1:1

### AC1 · ค่าขอบ ADL
| TC | Verify that… | ผล |
|---|---|---|
| PYG-569_01 ×6 | ADL 0 → สูง · 4 → สูง · 5 → กลาง · 11 → กลาง · 12 → ต้น · 20 → ต้น (ทั้ง `breakdown.adl` และ `requiredLevel` · flags/services = null · ตรวจคะแนนที่บันทึกจริงทุกชุด) | PASS 6/6 |

### AC2 · Flags
| TC | Verify that… | ผล |
|---|---|---|
| PYG-569_02 | one flag gives its level (สมองเสื่อมรุนแรง → สูง) | PASS |
| PYG-569_03 | several flags → highest *(seed: เบาหวาน + ฉีดยา → สูง)* | PASS (กลไก) |
| PYG-569_04 | no flag → flags criterion null (ไม่มีผล) | PASS |

### AC3 · สมองเสื่อม
| TC | Verify that… | ผล |
|---|---|---|
| PYG-569_05 | dementia + severe → flags สูง | PASS |
| PYG-569_06 | dementia not severe → ใช้กติกาทั่วไป ไม่ใช่แถว severe *(seed: กลาง)* | PASS (กลไก) · ระดับที่ถูกต้อง **BLOCKED** รอ infographic |

### AC4 · บริการ
| TC | Verify that… | ผล |
|---|---|---|
| PYG-569_07 ×3 | A04 → ต้น · A01 → กลาง (PYG-651 ปรับจากต้น) · E04 → สูง ตาม T-01 | PASS 3/3 |
| PYG-569_08 | กายภาพอย่างเดียว (ทั้ง `serviceType=physiotherapy` และกิจกรรม F03) → services สูง | PASS (ตามมติ 9 ต.ค. · การ์ดเขียนว่า "ไม่มีผล") |
| PYG-569_09 | กายภาพ + บริการอื่น (A01) → สูงสุดของสองตัว = สูง | PASS (การ์ดเขียนว่า "ได้ระดับของบริการอื่น") |
| PYG-569_10 | ประเภทบริการทั่วไปไม่มีกิจกรรม → services null | PASS |

### AC5 · สูงสุดของ 3 เกณฑ์ (ตารางรวมเกณฑ์ของการ์ด)
| TC | แถว | คาด | ผล |
|---|---|---|---|
| PYG-569_11a | ADL 12 + กายภาพอย่างเดียว | ~~ต้น~~ → สูง (มติ 9 ต.ค.) | PASS |
| _11b | ADL 5 + กายภาพอย่างเดียว | ~~กลาง~~ → สูง | PASS |
| _11c | ADL 4 + กายภาพอย่างเดียว | สูง | PASS |
| _11d | ADL 20 + สมองเสื่อมรุนแรง + บริการต้น | สูง | PASS |
| _11e | ADL 20 + Flag กลาง *(seed: เบาหวาน)* + บริการต้น | กลาง | PASS (กลไก) |
| _11f | ADL 12 + บริการสูง (E04) | สูง | PASS |
| _11g | ADL 12 + กายภาพ + บริการกลาง | ~~กลาง~~ → สูง | PASS |
| _11h | ADL 4 + Flag กลาง *(seed)* + บริการต้น | สูง | PASS (กลไก) |
| _11i | ADL 5 + Flag กลาง + Flag สูง *(seed)* + บริการต้น | สูง | PASS (กลไก) |
| _11j | ADL 11 + บริการต้น ไม่มี Flag (ADL ชนะ เกณฑ์อื่นไม่ลด) | กลาง | PASS |
| — | ADL 11 + **Flag ระดับต้น** + บริการต้น | กลาง | **BLOCKED** — ตารางกติกาไม่มี Flag ระดับต้นเลย (seed มีแค่กลาง/สูง) รอ infographic |

ทุกแถวตรวจด้วยว่า `requiredLevel` = ค่าสูงสุดของ `breakdown.adl/flags/services`

### AC6 · DB = API
| TC | Verify that… | ผล |
|---|---|---|
| PYG-569_12 | `required_level` + `level_from_adl/flags/services` + `level_calculated_at` ใน DB ตรงกับ REST และ `myBooking` (ADL 5 + สมองเสื่อมรุนแรง + A01 → สูง / กลาง / สูง / กลาง) | PASS |

### AC7 · คำนวณใหม่
| TC | Verify that… | ผล |
|---|---|---|
| PYG-569_13 | แก้แบบประเมินก่อนยืนยัน (ADL 12 → 4) → ระดับเปลี่ยนเป็นสูง | PASS |
| PYG-569_14 | แก้แบบประเมินหลังยืนยัน (เลือกผู้ดูแล → รับงาน → `confirmBooking`) → ระดับเท่าเดิม | PASS |
| — | แก้บริการของ booking ก่อนยืนยัน | **BLOCKED** ไม่มี API แก้บริการ (contract §4 / D3) |

### AC8
| TC | Verify that… | ผล |
|---|---|---|
| — | 5 เคสตัวอย่างจาก infographic → ต้น กลาง สูง กลาง ต้น | **BLOCKED** ไม่มีอินพุตของ 5 เคส (contract D4) และเนื้อหาเดิมอาศัย F03 ไม่มีผลซึ่งถูกแทนแล้ว |

### Edge cases
| TC | Verify that… | ผล |
|---|---|---|
| PYG-569_15 (E6) | ตอบไม่แน่ใจ 3 ข้อ → `hasUnsureFlag` + flags กลาง *(seed)* → ระดับสุดท้ายกลาง แม้ ADL 16 = ต้น | PASS (กลไก) |
| PYG-569_16 (E6) | ไม่แน่ใจ 2 ข้อ → ไม่มี Flag unsure | PASS |
| PYG-569_17 (E7) | Flag ที่ไม่มี active rule (ปิดแถว `fall_risk` ใน DB ทิ้งได้) → REST 422 `BOOKING_LEVEL_RULE_MISSING` · ไม่มี booking | PASS |
| PYG-569_18 (E9) | เพิ่มงานพิมพ์เอง "ฉีดยา / ดูดเสมหะ / กายภาพบำบัด" → ระดับเท่าเดิม services null | PASS |
| PYG-569_19 (E10) | 2 booking ยังไม่ยืนยัน แก้แบบประเมินครั้งเดียว → ทั้งสองเปลี่ยน | PASS |
| PYG-569_20 (E11) | booking ก่อนฟีเจอร์ → `requiredLevel` / `levelBreakdown` null ไม่ error | PASS |
| PYG-569_21 | client ส่งระดับเอง → REST 400 `property requiredLevel should not exist` | PASS |
| PYG-569_22 | ผู้ใช้อื่น / ผู้ดูแลอื่น / ไม่ล็อกอิน อ่านระดับไม่ได้ | PASS |
| PYG-569_23 | ผู้ดูแลที่ถูกเลือกเห็นระดับเท่ากับผู้จอง | PASS |
| — | role ที่ไม่ควรเห็นระดับรายเกณฑ์ | **BLOCKED** ยังไม่เคาะสิทธิ์ราย field (contract D1) |

## 2. สรุป

| | จำนวน |
|---|---|
| PASS | 23 TC (39 รอบ) — ในนี้ 6 รอบเป็น "กลไก" ที่ใช้ระดับ Flag จาก seed |
| FAIL | 0 |
| BLOCKED | 5: ระดับ Flag ทั่วไปของสมองเสื่อม/Flag อื่น (infographic) · แถว Flag ระดับต้น · แก้บริการ (ไม่มี API) · AC8 5 เคส (D4) · สิทธิ์ราย field (D1) |

## 3. Production (อ่านอย่างเดียว · 2026-10-20)

- `prisma/checks/booking_level_readiness.sql` → **0 แถว** (กติกา 12 แถวครบ ระดับตรง รวม F03 = advanced)
- คอลัมน์ `required_level`, `level_from_*`, `level_calculated_at` + CHECK 4 ตัวมีครบ · booking ที่คำนวณระดับแล้ว 0 (ยังไม่มีการจองใหม่)

## 4. รันซ้ำ

```bash
QA_DATABASE_URL=postgresql://postgres:qa@127.0.0.1:5436/<db> npm run test:e2e -- --runInBand test/pyg640
```
DB ใหม่ / รันซ้ำ: 39/39 ทั้งสองรอบ · รวม 4 ชุด QA ใน DB เดียว (แบบ CI) 2 รอบ: 154/154
