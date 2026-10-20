# PYG-644 · QA Required Skills ของ booking (S17 · PYG-570)

- การ์ด: PYG-644 (QA) · Story: PYG-570 · ขึ้นกับ: PYG-641 (contract), PYG-642 (DB · seed 15 ทักษะ / 18 กติกา), PYG-643 (BE · #141), #144 (ลำดับคำนวณหลังบันทึกกิจกรรม)
- Commit ที่ทดสอบ: `origin/dev` @ `83ccd4d` · harness จาก PR #145 (PYG-636)
- รัน: 2026-10-20 · Created By / Execute By: Wasan. R
- Spec: `test/pyg644-required-skills.e2e-spec.ts` · harness: `test/support/qa-e2e.ts` (เพิ่ม `submitAssessment`)
- **ผล: รันได้ 28 TC → PASS 28 (30 รอบรวมค่าย่อย) · FAIL 0 · BLOCKED 6 กลุ่ม (รอ infographic / S16 / มติผู้ช่วยพยาบาล / API แก้บริการ)**
- **รันซ้ำ 2026-10-20 หลัง #147 (`fb20b70`): 30/30 PASS** · ระดับ booking ของ AC7 (S16) ทดสอบแล้วใน PYG-640 (`PYG-569_08`, `_11`) — ตามมติ 9 ต.ค. กายภาพบำบัดได้ระดับสูงเสมอ ไม่ใช่ ต้น/กลาง/สูง ตาม ADL · ปรับ harness: จองแบบไม่ระบุผู้ดูแล แล้วเลือกผ่าน `selectBookingCaregiver` ใน _14 / _18
- ไม่พบบั๊ก → ไม่มี bug card

## 0. ต้นทางของ expected result — อ่านก่อน

การ์ดสั่ง **ห้ามตั้ง expected จากตารางกติกาในฐานข้อมูล** และ **ยืนยันกติกาได้เอง 4 ข้อจาก 14** ส่วนอีก 10 ข้อต้องรอ infographic ฉบับล่าสุด ซึ่ง **ยังไม่ได้แนบในการ์ดและไม่มีใน repo** และ contract PYG-641 §11 / D5 บันทึกไว้ว่า story ระบุ ADL 6 / Flags 5 / บริการ 3 (14) แต่ seed มี 7 / 5 / 6 (18) ยังไม่มีผู้ยืนยันว่าชุดใดใช้งาน

ดังนั้น:
- **ยืนยันตามการ์ด (expected จากการ์ด):** Transfer = 1 → `transfer_assist` · อาบน้ำ = 0 → `bathing` · Flag ต้องฉีดยา → `injection` ล็อก `nurse` · จองกายภาพบำบัด → `physiotherapy` ล็อก `physiotherapist` เท่านั้น
- **ทดสอบกลไก (คู่กติกาจาก seed ระบุในชื่อเคส):** การรวมแหล่งซ้ำ (AC4), E11 — ตรวจว่าโค้ดทำงานถูกกับกติกาใดก็ได้ ไม่ได้รับรองว่ากติกานั้นถูกตามอาจารย์
- **BLOCKED:** กติกาอีก 10 ข้อ (AC1 4 ข้อ · AC2 4 ข้อ · AC3 2 ข้อ)

## 1. Test case sheet

### AC1 · ADL
| TC | Verify that… | ขั้นตอน → expected | ผล |
|---|---|---|---|
| PYG-570_01 | Transfer = 1 gives `transfer_assist` from ADL | 1. แบบประเมิน Transfer 1 · 2. จอง → 201 · 3. `myBooking.requiredSkills` → มี `transfer_assist` sources `[ADL]` | PASS |
| PYG-570_02 | Transfer = 3 gives no `transfer_assist` | 1. Transfer 3 · 2. จอง · 3. ไม่มี `transfer_assist` | PASS |
| PYG-570_03 | Bathing = 0 gives `bathing` from ADL | 1. อาบน้ำ 0 · 2. จอง · 3. มี `bathing` `[ADL]` | PASS |
| PYG-570_04 | Bathing = 1 gives no `bathing` | 1. อาบน้ำ 1 · 2. จอง · 3. ไม่มี `bathing` | PASS |
| — | กติกา ADL อีก 4 ข้อ (บวก + ลบ) | — | **BLOCKED** รอ infographic |
| — | Transfer = 0 (เงื่อนไข "เท่ากับ" หรือ "ไม่เกิน") | — | **BLOCKED** ตามการ์ด (ยังไม่เคาะ) — ข้อมูล: seed ใช้ช่วง 0–1 ได้ `transfer_assist` |

### AC2 · Flags
| TC | Verify that… | ขั้นตอน → expected | ผล |
|---|---|---|---|
| PYG-570_05 | the "needs injection" flag gives `injection` from FLAG, locked to nurse | 1. Flag `injection` · 2. จอง · 3. `injection` sources `[FLAG]` `lockedProfessions [nurse]` | PASS |
| PYG-570_06 | with no flag no skill comes from FLAG | 1. ไม่มี Flag · 2. จอง · 3. ไม่มีรายการใดมี `FLAG` | PASS |
| — | Flags อีก 4 ข้อ | — | **BLOCKED** รอ infographic |

### AC3 · บริการ
| TC | Verify that… | ขั้นตอน → expected | ผล |
|---|---|---|---|
| PYG-570_07 | booking physiotherapy (service type) gives `physiotherapy` from SERVICE | 1. จอง `serviceType=physiotherapy` · 2. `physiotherapy` `[SERVICE]` | PASS |
| PYG-570_08 | booking the physiotherapy activity (F03) gives `physiotherapy` | 1. จองพร้อมกิจกรรม F03 · 2. `physiotherapy` `[SERVICE]` (ทางนี้ใช้ได้เพราะ #144) | PASS |
| PYG-570_09 | another service without physiotherapy adds no `physiotherapy` | 1. จองกิจกรรม A04 · 2. ไม่มี `physiotherapy` (ไม่ถูกเติมเอง) | PASS |
| — | บริการอีก 2 ข้อ | — | **BLOCKED** รอ infographic |

### AC4 · ทักษะซ้ำ
| TC | Verify that… | ขั้นตอน → expected | ผล |
|---|---|---|---|
| PYG-570_10 | one skill from 2 sources appears once with 2 sources *(คู่จาก seed: Flag injection + กิจกรรม D05)* | 1. Flag injection + จอง D05 · 2. `injection` 1 รายการ sources `[FLAG, SERVICE]` · 3. DB 1 แถว | PASS |
| PYG-570_11 | 3 sources for one skill is not possible with the current table | 1. นับแหล่งของทุกทักษะในกติกาที่เปิดใช้ → ไม่มีทักษะใดมีครบ ADL+FLAG+SERVICE (ตามการ์ด "ถ้าตารางทำให้เกิดได้") | PASS (ไม่เกิดได้) |
| PYG-570_12 | two ADL items giving one skill list ADL once *(seed: bladder 0 + bowels 0 → toileting_care)* | 1. ทั้งสองข้อ 0 · 2. `toileting_care` 1 รายการ sources `[ADL]` ไม่ซ้ำ | PASS |

### AC5 · DB ตรงกับ API
| TC | Verify that… | ขั้นตอน → expected | ผล |
|---|---|---|---|
| PYG-570_13 | DB rows match the API (codes + sources) and both DB stores agree | 1. Transfer 1 + อาบน้ำ 0 + Flag injection + จองกายภาพ · 2. `requiredSkills` ↔ `booking_required_skills` ตรงทั้งรหัสและแหล่ง · 3. `bookings.required_skills` = เซตรหัสของแถว · มีครบ 4 ทักษะที่การ์ดยืนยัน | PASS |
| PYG-570_14 | the caregiver sees the same list as the booker | 1. จอง · 2. `caregiverBooking.requiredSkills` = `myBooking.requiredSkills` | PASS |

### AC6
| TC | Verify that… | ขั้นตอน → expected | ผล |
|---|---|---|---|
| PYG-570_15 | Transfer = 1 and Bathing = 0 give `transfer_assist` and `bathing`, from ADL, not locked | 1. แบบประเมิน · 2. จอง · 3. ทั้งสอง `[ADL]` `lockedProfessions []` | PASS |

### AC7 · กายภาพบำบัดที่ทุกระดับ
| TC | Verify that… | ขั้นตอน → expected | ผล |
|---|---|---|---|
| PYG-570_16 ×3 | ADL total 12 / 5 / 4 + physiotherapy only gives `physiotherapy` (locked to physiotherapist) | 1. แบบประเมินรวม 12 / 5 / 4 (ตรวจค่าที่บันทึก) ไม่มี Flag · 2. จองกายภาพอย่างเดียว · 3. `physiotherapy` `[SERVICE]` `[physiotherapist]` | PASS 3/3 |
| — | ระดับ booking เป็น ต้น / กลาง / สูง | — | **BLOCKED** ยังไม่มีโค้ด S16 เขียน `required_level` |

### AC8 · คำนวณใหม่
| TC | Verify that… | ขั้นตอน → expected | ผล |
|---|---|---|---|
| PYG-570_17 | editing the assessment before confirmation updates the list, no stale rows | 1. Transfer 1 + อาบน้ำ 0 · 2. จอง → มี `transfer_assist` · 3. แก้ Transfer 3 → `transfer_assist` หาย `bathing` อยู่ · 4. DB ไม่มีแถวค้าง และสองที่เก็บตรงกัน | PASS |
| PYG-570_18 | editing the assessment after confirmation does not change the list | 1. จอง · 2. ผู้ดูแลรับ · 3. ผู้จอง `confirmBooking` · 4. แก้แบบประเมิน (+Flag injection) → รายการเท่าเดิม | PASS |
| PYG-570_19 | one assessment edit recalculates both unconfirmed bookings | 1. จอง 2 ใบ · 2. แก้แบบประเมินเพิ่ม Flag injection 1 ครั้ง · 3. ทั้งสองใบมี `injection` `[FLAG]` | PASS |
| — | แก้บริการของ booking ก่อนยืนยัน รายการเปลี่ยนตาม | — | **BLOCKED** ไม่มี API แก้บริการของ booking ที่สร้างแล้ว (มีแค่สร้าง / ยืนยัน / แก้แบบประเมิน) |

### ตารางเคสคำนวณ + Edge cases
| TC | Verify that… | ขั้นตอน → expected | ผล |
|---|---|---|---|
| PYG-570_20 (E3) | fully independent, no flag, service without rules → `[]` not null | 1. คะแนนเต็มทุกข้อ ไม่มี Flag บริการ elderly_care · 2. `requiredSkills = []` · 3. `bookings.required_skills = '{}'` | PASS |
| PYG-570_21 (E8) | same ADL total, different items → different lists | 1. ชุด A (Transfer 1) และ C (อาบน้ำ 0, grooming 0) รวม 18 เท่ากัน · 2. A มี `transfer_assist` ไม่มี `bathing` · C กลับกัน | PASS |
| PYG-570_22 (E5) | "unsure" on Transfer is treated as 0 → `transfer_assist` | 1. Transfer = null (ไม่แน่ใจ) · 2. ได้ `transfer_assist` `[ADL]` ตามมติ Sammy 9 ต.ค. (contract S08) | PASS |
| PYG-570_23 (E7) | typed sub-tasks do not change the list | 1. จองปกติ · 2. จองซ้ำพร้อมงานพิมพ์ "ฉีดยาอินซูลิน / กายภาพบำบัดขา / ดูดเสมหะ" → รายการเท่ากัน | PASS |
| PYG-570_24 (E10) | a booking made before the feature returns null without error | 1. ทำให้ booking ไม่เคยคำนวณ (`required_skills = NULL`, ไม่มีแถว) · 2. `myBooking` ไม่ error `requiredSkills = null` | PASS |
| PYG-570_25 (E11) | a matching rule pointing to an inactive skill → `SKILL_RULE_INVALID`, nothing saved *(ปิด `transfer_assist` ใน DB ทิ้งได้)* | 1. ปิดทักษะ · 2. จองด้วย Transfer 1 → REST 422 `SKILL_RULE_INVALID` · 3. จำนวน booking / แถวทักษะเท่าเดิม · 4. Transfer 3 (ไม่เข้ากติกา) → 201 · 5. เปิดคืน | PASS |
| PYG-570_26 | the client cannot supply required skills | 1. REST ส่ง `requiredSkills` / `required_skills` → 400 `property requiredSkills should not exist` · 2. GraphQL `createBookingOnBehalf` ช่องบังคับครบ + `requiredSkills` → `BAD_USER_INPUT` ระบุ `requiredSkills` | PASS |
| PYG-570_27 | a user without access cannot read the list | 1. ผู้ใช้อื่น `myBooking` → error data null · 2. ผู้ดูแลอื่น `caregiverBooking` → null · 3. ไม่ล็อกอิน → `UNAUTHENTICATED` | PASS |
| PYG-570_28 | general skills are not profession-locked | 1. `careSkills` → `transfer_assist`, `bathing` `lockedProfessions []` | PASS |
| — | ค่าขอบ ADL รวม 4↔5 และ 11↔12: รายการเหมือนกัน ระดับต่างกัน | — | **BLOCKED** ต้องรู้ข้อที่ไม่มีกติกา (infographic) + ระดับ (S16) |
| — | ล็อกวิชาชีพของ สายยางให้อาหาร / ท่อเจาะคอ / ดูดเสมหะ / แผลหน้าท้อง | — | **BLOCKED** ตามการ์ด (มติผู้ช่วยพยาบาล) — ข้อมูล: ปัจจุบันตอบ `[nurse]` ทั้ง 4 |

## 2. สรุปผล

| | จำนวน |
|---|---|
| PASS | 28 TC (30 รอบ) |
| FAIL | 0 |
| BLOCKED | 6 กลุ่ม: กติกา 10 ข้อ (infographic) · ระดับ booking ใน AC7 (S16) · แก้บริการก่อนยืนยัน (ไม่มี API) · ค่าขอบ 4/5 และ 11/12 (infographic + S16) · ล็อกวิชาชีพ 4 ทักษะ (มติผู้ช่วยพยาบาล) · Transfer = 0 (เงื่อนไขเท่ากับ/ไม่เกิน) |

**ต้องการจากทีมเพื่อปลด BLOCKED:** แนบ infographic ฉบับล่าสุด (ตาราง 6 / 5 / 3) ในการ์ด และยืนยันว่า seed 7 / 5 / 6 ตรงกับฉบับไหน (contract D5)

## 3. ตรวจ production (อ่านอย่างเดียว · 2026-10-20) — query ของ PYG-642

| ตรวจ | คาด | ผล |
|---|---|---|
| กติกาต่อแหล่ง | adl 7 · flag 5 · service 6 | adl 7 · flag 5 · service 6 |
| `care_skills` | 15 | 15 (ปิดใช้ 0) · กติกาปิดใช้ 0 |
| กติกาที่อ้างทักษะไม่มีอยู่ | 0 | 0 |
| กติกาบริการที่ไม่มีกิจกรรม / Flag ที่ไม่มีใน `booking_level_rules` | 0 / 0 | 0 / 0 |
| booking ที่มีทักษะแล้ว · แถว `booking_required_skills` | 0 | 0 · 0 (ยังไม่มีการจองใหม่) |
| md5 ของตารางกติกาทั้ง 18 แถว | = DB ทดสอบ | `2eb6974922e06576196be378339955c9` ตรงกัน |

## 4. วิธีรันซ้ำ

```bash
# DB ทิ้งได้จาก schema.prisma (ดู docs/qa/pyg-636-care-activities-report.md §4)
QA_DATABASE_URL=postgresql://postgres:qa@127.0.0.1:5436/qa644 npm run test:e2e -- --runInBand test/pyg644
# spec ล้าง care_skill_rules / care_skills / care_activities แล้วรัน seed ของ S15 + S17 เอง
```

| ตรวจ | ผล |
|---|---|
| DB ใหม่ / รันซ้ำบน DB เดิม | 30 / 30 passed |
| รวมกับ PYG-636 ใน DB เดียว (แบบ CI) สองรอบ | 68 / 68 passed ทั้งสองรอบ |
| ไม่ตั้ง env / `CI=1` | skip / ล้มพร้อมเหตุผล (harness เดียวกับ PYG-636) |
| `tsc` · eslint ไฟล์ใหม่ | 0 · 0 |
