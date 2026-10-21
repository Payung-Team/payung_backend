# PYG-583 · QA กำหนด แก้ และแสดงระดับผู้ดูแล (S02 · PYG-557)

- การ์ด: PYG-583 (QA) · Story: PYG-557 · ขึ้นกับ: PYG-579 (contract), PYG-580 (DB), PYG-581 (BE), PYG-582 (FE)
- Commit ที่ทดสอบ: `origin/dev` @ `e75a3c0`
- รัน: 2026-10-21 · Created By / Execute By: Wasan. R
- Spec: `test/pyg583-care-level.e2e-spec.ts` (GraphQL เข้าแอปจริง ต่อ Postgres ทิ้งได้ใน Docker) + query อ่านอย่างเดียวบน production
- **ผล: PASS 24 TC (39 รอบใน spec + 1 บน production) · FAIL 1 → PYG-668 (Medium · ข้อมูลค้างบน production) · BLOCKED 2 (E7, E8) · NOT RUN (หน้าจอ) 6**

## 0. ต้นทางของ expected

- story PYG-557: R1–R7, E1–E9
- contract PYG-579 §4–§5: `CARE_LEVEL_REQUIRED` / `CARE_LEVEL_INVALID` / `CARE_LEVEL_REASON_REQUIRED` / `CARE_LEVEL_KYC_NOT_VERIFIED`, `changed: false` เมื่อค่าเดิม (E4), `needsReview`
- มติ 2026-10-18 (ในโค้ด PYG-581): เลือกระดับพร้อมคำสั่งอนุมัติ · บังคับเหตุผลเมื่อเปลี่ยนจริง · ค่าเดิมจาก migration ที่แอดมินยืนยันซ้ำ = นับเป็นการทบทวน (เขียนประวัติ old = new)
- ไม่ตัดสินว่าระดับที่แอดมินเลือกถูกหรือไม่ (เกณฑ์ยังไม่มี) — ตรวจเฉพาะกลไก

## 1. Test case sheet

### AC1 · กำหนด 3 ค่า
| TC | Verify that… | ผล |
|---|---|---|
| PYG-557_01 ×3 | `approveKyc(careLevel)` ด้วย BASIC / INTERMEDIATE / ADVANCED → `verified` + ระดับตรงใน DB + ประวัติ `KYC_APPROVAL` (old = null, ผู้ทำ = แอดมิน) | PASS 3/3 |
| PYG-557_02 | enum `CareLevel` มี BASIC, INTERMEDIATE, ADVANCED เท่านั้น | PASS |
| PYG-557_03 ×4 | อนุมัติด้วย `EXPERT` / `basic` / `ต้น` / `toString` → `CARE_LEVEL_INVALID` (+ `allowed`, `received`) · ยัง pending · ไม่มีประวัติ ไม่มี `kyc_reviews` | PASS 4/4 |
| PYG-557_04 | `setCaregiverCareLevel` ด้วย `EXPERT` → `CARE_LEVEL_INVALID` ระดับเดิมคงอยู่ | PASS |
| — | dropdown ในหน้า KYC review มี 3 ค่า | NOT RUN (FE) |

### AC2 · อนุมัติไม่ได้ถ้าไม่มีระดับ
| TC | Verify that… | ผล |
|---|---|---|
| PYG-557_05 ×4 | อนุมัติโดยไม่ส่ง / `null` / `""` / `"   "` → `CARE_LEVEL_REQUIRED` · `kyc_status` ยัง pending · ไม่มีประวัติ ไม่มี `kyc_reviews` | PASS 4/4 |
| PYG-557_06 | ปฏิเสธ KYC ได้โดยไม่มีระดับ (E2) · ระดับยัง null | PASS |
| — | หน้าจอกันปุ่มอนุมัติเมื่อยังไม่เลือก | NOT RUN (FE) |

### AC3 · ผู้กำหนดและเวลา
| TC | Verify that… | ผล |
|---|---|---|
| PYG-557_07 | `care_level_set_by` = แอดมินที่ล็อกอิน · `care_level_set_at` อยู่ในช่วงเวลาของคำสั่ง (เทียบนาฬิกา DB) · `adminKycDetail.careLevelInfo` มี setBy / setByName / setAt ตรง | PASS (ข้อมูล API) |
| — | หน้า KYC review แสดงผู้กำหนดและเวลา | NOT RUN (FE) |

### AC4 · แก้ภายหลังและประวัติ
| TC | Verify that… | ผล |
|---|---|---|
| PYG-557_08 | แอดมินอีกคนเปลี่ยน BASIC → INTERMEDIATE · DB เปลี่ยน · ประวัติมี old / new / ผู้ทำ / ชื่อ / เหตุผล / เวลา / `ADMIN_UPDATE` | PASS |
| PYG-557_09 | เปลี่ยน 3 ครั้ง → ประวัติเรียงใหม่ไปเก่า เวลาไม่ซ้ำ และ old ของแต่ละแถว = new ของแถวก่อนหน้า | PASS |
| PYG-557_10 ×3 | เปลี่ยนโดยเหตุผล `null` / `""` / `"   "` → `CARE_LEVEL_REASON_REQUIRED` ไม่เปลี่ยนอะไร | PASS 3/3 |

### AC5 · ผู้ดูแลเห็นระดับตัวเอง
| TC | Verify that… | ผล |
|---|---|---|
| PYG-557_11 ×3 | `myCaregiverProfile.careLevel` ตรงทั้ง 3 ค่า | PASS 3/3 (ข้อมูล API) |
| PYG-557_12 | หลังแอดมินเปลี่ยน ผู้ดูแลเห็นค่าใหม่ทันที | PASS |
| — | ป้ายระดับในหน้าโปรไฟล์ | NOT RUN (FE) |

### AC6 · ผู้ดูแลเดิมได้ค่าเริ่มต้น ต้น
| TC | Verify that… | ผล |
|---|---|---|
| PYG-557_13 | ผู้ดูแลแบบหลัง migration (basic, set_by NULL, set_at = เวลา migration) → `adminKycList.careLevelNeedsReview = true` · `careLevelInfo.needsReview = true` · ประวัติ `MIGRATION_DEFAULT` | PASS |
| PYG-557_14 | แอดมินยืนยันระดับเดิม (BASIC + เหตุผล) → `changed: true` · ตัวบอกหาย · มีผู้กำหนด · ประวัติ old = new = BASIC | PASS |
| PYG-557_24 | **production**: ผู้ดูแล verified ทุกแถวมีระดับหลัง migration | **FAIL → PYG-668** (ดู §2) |
| — | ตัวบอก "ยังไม่ทบทวน" บนหน้าจอ | NOT RUN (FE) |

### Edge cases
| TC | Verify that… | ผล |
|---|---|---|
| PYG-557_15 (E4) | แอดมินบันทึกค่าเดิมที่แอดมินกำหนดไว้แล้ว → `changed: false` · ไม่มีแถวประวัติเพิ่ม · ผู้กำหนด/เวลาเดิมไม่ถูกทับ (แม้คนกดเป็นแอดมินอีกคน) | PASS |
| PYG-557_16 ×3 (E5) | ผู้ดูแล pending / none / rejected เปิดโปรไฟล์ → `careLevel: null` ไม่มี error | PASS 3/3 |
| PYG-557_17 (E6) | แอดมิน 2 คนเปลี่ยนพร้อมกัน → ประวัติ 2 แถว · old ของแถวหลัง = new ของแถวแรก · ค่าใน DB = แถวล่าสุด | PASS |
| PYG-557_18 ×3 (R7) | `setCaregiverCareLevel` กับ pending / rejected / none → `CARE_LEVEL_KYC_NOT_VERIFIED` (+ `kycStatus`) ไม่ได้ระดับ | PASS 3/3 |
| PYG-557_25 (E9) | **production**: CHECK 3 ค่าบน `caregivers.care_level`, `caregiver_care_level_logs.old_level` / `new_level` มีจริง | PASS |
| E7 | ลดระดับผู้ดูแลที่มี booking ค้างซึ่งต้องการระดับสูงกว่า | BLOCKED — story ยังไม่เคาะ (ต้องตกลงกับ S18) |
| E8 | ผู้ดูแลถูกส่งกลับเข้าตรวจ KYC (เช่น เปลี่ยนวิชาชีพ) คงระดับเดิมหรือกำหนดใหม่ | BLOCKED — story ยังไม่เคาะ (โค้ดคงระดับเดิมเมื่อไม่ส่งมา แต่ไม่มีทางกลับเข้า pending ให้ทดสอบ) |

### สิทธิ์
| TC | Verify that… | ผล |
|---|---|---|
| PYG-557_19 (R3) | ผู้ดูแลตั้งระดับตัวเอง / อนุมัติตัวเอง → `FORBIDDEN` ไม่เปลี่ยนอะไร · `KycInput`, `UpdateCaregiverInput` ไม่มี field `careLevel` | PASS |
| PYG-557_20 | ผู้ดูแล A ตั้งระดับ / อ่านประวัติ / อ่าน `adminKycDetail` ของ B → `FORBIDDEN` · `data = null` | PASS |
| PYG-557_21 | ผู้ใช้ Elder ตั้งระดับ / อ่านประวัติ → `FORBIDDEN` | PASS |
| PYG-557_22 | ไม่ล็อกอิน ตั้งระดับ / อ่านประวัติ / อนุมัติ → `UNAUTHENTICATED` | PASS |
| PYG-557_23 | Super Admin (role 4) เปลี่ยนระดับได้ และเป็นผู้กำหนด | PASS |
| — | ป้ายระดับไม่ล้นและไม่ทับป้ายวิชาชีพที่ความกว้างมือถือ | NOT RUN (FE) |

## 2. ผลตรวจ production (อ่านอย่างเดียว · 2026-10-21)

| รายการ | ค่า |
|---|---|
| migration `20261007010000_pyg557_caregiver_care_level` | applied |
| ผู้ดูแล verified | 53 |
| — `basic` / ยังไม่ทบทวน (set_by NULL) | 50 |
| — **ไม่มีระดับ** | **3 → PYG-668** |
| ผู้ดูแลไม่ verified แต่มีระดับ | 0 |
| ผู้ดูแลที่ยังไม่ทบทวนแต่ไม่ใช่ `basic` | 0 |
| แถวประวัติ `migration_default` | 50 (รูปแบบถูกทุกแถว: old NULL, new basic, changed_by NULL) |
| ผู้ดูแลที่มีระดับแต่ไม่มีแถวประวัติ | 0 |
| แถวประวัติที่แอดมินเขียน | 0 (ยังไม่มีแอดมินทบทวนใคร) |
| CHECK 3 ค่า (3 constraint) | มีครบ |

**PYG-668:** 3 คนถูกอนุมัติวันที่ 10, 13, 17 ต.ค. — หลัง migration (7 ต.ค.) แต่ก่อนโค้ดบังคับระดับเข้า dev (PR #131, 18 ต.ค.) จึงหลุด backfill
ตรวจแล้วว่าทางเดียวที่เขียน `verified` คือ `approveKyc` ซึ่งบังคับระดับแล้ว → ไม่เกิดเพิ่ม · แก้ได้โดยแอดมินตั้งระดับผ่าน `setCaregiverCareLevel` (ทางเดียวกับ PYG-557_08) ไม่ต้องมี migration

ข้อสังเกตต่อ S18: ผู้ดูแล verified ทั้ง 50 คนยังเป็น `basic` ที่ไม่ผ่านการทบทวน → booking ระดับกลาง/สูงจะไม่มีผู้ดูแลผ่านเลยจนกว่าแอดมินทบทวน (ตรงกับประเด็นที่ story เปิดไว้)

## 3. สรุป

| ผล | จำนวน |
|---|---|
| PASS | 24 TC (39 รอบใน spec + PYG-557_25 บน production) |
| FAIL | 1 → **PYG-668** (ข้อมูลค้าง 3 แถว · ไม่ใช่บั๊กโค้ด) |
| BLOCKED | 2 (E7, E8 — story ยังไม่เคาะ) |
| NOT RUN | 6 (หน้าจอ: dropdown 3 ค่า, กันปุ่มอนุมัติ, แสดงผู้กำหนด/เวลา, ป้ายในโปรไฟล์, ตัวบอกยังไม่ทบทวน, มือถือ) |

## 4. หลักฐานและหมายเหตุการรัน

```
QA_DATABASE_URL=postgresql://postgres:qa@127.0.0.1:5436/<db> npm run test:e2e -- --runInBand test/pyg583
```
- เวอร์ชันสุดท้ายรันซ้ำ 4 รอบติด: 39/39 ทุกรอบ (ก่อนหน้านั้น หลังเปลี่ยนเคสเวลาไปเทียบนาฬิกา DB รัน 6 รอบติด: 39/39)
- เวลาของระดับบันทึกด้วย `clock_timestamp()` ของ DB → เคสเวลา (PYG-557_07/08) เทียบกับนาฬิกา DB ไม่ใช่ `Date.now()` — ระหว่างรันพบนาฬิกา Postgres ใน Docker ช้ากว่าเครื่อง ~15 วินาทีเป็นพัก ๆ (เป็นของสภาพแวดล้อม ไม่ใช่บั๊ก)
- แถว `migration_default` ใน DB ทิ้งได้ตั้ง `created_at` และ `care_level_set_at` ชัด ๆ เหมือน migration จริง (DB สร้างจาก `schema.prisma` ไม่ได้ replay migration)
- `UpdateProfileInput` (AuthModule ไม่อยู่ใน harness) ตรวจจาก DTO `src/identity/auth/dto/update-profile.input.ts`: ไม่มี `careLevel`
- ไม่มีการเขียนข้อมูลบน production
