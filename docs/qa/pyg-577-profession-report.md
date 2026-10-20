# PYG-577 · QA ระบุและแสดงวิชาชีพ (S01 · PYG-556)

- การ์ด: PYG-577 (QA) · Story: PYG-556 · ขึ้นกับ: PYG-573 (contract), PYG-574 (DB), PYG-575/663 (BE), PYG-576/664/665 (FE)
- Commit ที่ทดสอบ: `origin/dev` @ `fb20b70`
- รัน: 2026-10-20 · Created By / Execute By: Wasan. R
- Spec: `test/pyg577-profession.e2e-spec.ts` (DB จริงทั้งเส้นทาง · ต่างจาก `test/pyg575-profession-graphql.e2e-spec.ts` ที่ mock Prisma)
- **ผล: PASS 13 TC (20 รอบ) + AC5 บน production · FAIL 1 → PYG-667 (High · S18) · NOT RUN (หน้าจอ) 4**

## 1. Test case sheet

### AC1 · ต้องเลือกวิชาชีพ
| TC | Verify that… | ผล |
|---|---|---|
| PYG-556_01 | `submitKyc` ไม่ส่ง `profession` → `PROFESSION_REQUIRED` · ไม่มีแถว `caregivers` ถูกสร้าง | PASS |
| — | หน้าจอกันการส่งเมื่อไม่เลือก | NOT RUN (FE) |

### AC2 · 3 ค่าเท่านั้น
| TC | Verify that… | ผล |
|---|---|---|
| PYG-556_02 | enum `CaregiverProfession` มี `general_caregiver`, `nurse`, `physiotherapist` เท่านั้น | PASS |
| PYG-556_03 ×3 | KYC แต่ละวิชาชีพบันทึกถูก (พยาบาล/นักกายภาพแนบใบประกอบฯ ตาม S03 · ทักษะตามวิชาชีพ) → `kycStatus = pending`, DB ตรง | PASS 3/3 |
| PYG-556_04 ×4 | `doctor` / `NURSE` / `พยาบาล` → `PROFESSION_INVALID` · `""` → `PROFESSION_REQUIRED`/`INVALID` · ไม่มีแถวถูกสร้าง | PASS 4/4 |

### AC3–AC4 · ฝั่ง Elder
| TC | Verify that… | ผล |
|---|---|---|
| PYG-556_05 | รายการ (`searchCaregivers`) มีวิชาชีพของผู้ดูแลทุกคน ครบ 3 ค่า | PASS (ข้อมูล API) |
| PYG-556_06 ×3 | โปรไฟล์ (`GET /api/v1/caregivers/:id/public`) แสดงวิชาชีพตรงกับที่บันทึก ทั้ง 3 ค่า | PASS 3/3 (ข้อมูล API) |
| — | ป้ายบนการ์ด/หน้า Profile แสดงจริง · ป้ายไม่ล้นมือถือ | NOT RUN (FE) |

### AC5 · migration (production อ่านอย่างเดียว · 2026-10-20)
| ตรวจ | ผล |
|---|---|
| แถว `profession` เป็น NULL | **0** จาก 94 |
| คอลัมน์ | `NOT NULL DEFAULT 'general_caregiver'` |
| CHECK | `profession = ANY ('general_caregiver','nurse','physiotherapist')` |
| การกระจาย | ผู้ดูแลทั่วไป 93 · พยาบาล 1 (ไม่มี log เปลี่ยนวิชาชีพ = มาจาก KYC) |
| **ผล** | **PASS** |

### AC6 · ขอเปลี่ยนวิชาชีพหลัง KYC อนุมัติ
| TC | Verify that… | ผล |
|---|---|---|
| PYG-556_07 | ระหว่างคำขอรอ ฝั่ง Elder (List + Profile) ยังเห็นค่าเดิม · แอดมินอนุมัติแล้วเห็นค่าใหม่ · `caregiver_edit_logs` มีแถว request + approve พร้อมค่าเดิม/ค่าใหม่ | PASS |
| PYG-556_08 | แอดมินปฏิเสธ → วิชาชีพคงเดิม (API + DB) | PASS |

### Edge cases
| TC | Verify that… | ผล |
|---|---|---|
| PYG-556_09 (E2) | KYC ถูกปฏิเสธ → ส่งใหม่เปลี่ยนวิชาชีพได้เลย (`pending`) ไม่มีคำขอเปลี่ยนวิชาชีพแยก | PASS |
| PYG-556_10 (E1) | ฟอร์ม KYC ที่ค้างไว้ก่อน deploy ส่งโดยไม่เลือกวิชาชีพ → `PROFESSION_REQUIRED` | PASS (API) · การบังคับเลือกบนจอ NOT RUN |
| PYG-556_11 | ผู้ดูแล A อนุมัติ/ปฏิเสธคำขอของ B ไม่ได้ (`FORBIDDEN`) · input ของคำขอไม่มีช่องระบุผู้ดูแลอื่น | PASS |
| PYG-556_12 | ผู้ใช้ฝั่ง Elder ขอ/อนุมัติเปลี่ยนวิชาชีพ → `FORBIDDEN` | PASS |
| PYG-556_13 | ขอเปลี่ยนเป็นพยาบาลโดยไม่แนบใบประกอบฯ → ถูกปฏิเสธ ไม่มี log | PASS |
| **PYG-556_15** | **ผู้ดูแลที่เปลี่ยนเป็นพยาบาลผ่านคำขอที่อนุมัติแล้ว ผ่านตัวกรอง S18 สำหรับงานฉีดยา** | **FAIL → PYG-667 (High)** · `it.failing` |

**PYG-667 (ต่อเนื่องจาก S01 ถึง S18):** ใบประกอบฯ อนุมัติแล้ว ยังไม่หมดอายุ วิชาชีพเป็นพยาบาลแล้ว แต่ `bookingMatchReport` ให้ `EVIDENCE_NOT_APPROVED (injection)` — `src/matching/matching.persistence.ts` เทียบ `field_changes.newValue` ที่เก็บแบบ JSON-stringified (`'"nurse"'` ตามกติกา `computeFieldChanges`) กับ `caregivers.profession` (`'nurse'`) ตรง ๆ จึงตัดใบที่แนบกับคำขอทิ้ง · ผู้ดูแลที่เลือกพยาบาลตั้งแต่ KYC ไม่โดน · ยังไม่กระทบ production (log เปลี่ยนวิชาชีพบน prod = 0)

> แก้ไขเพิ่มใน PR นี้: `PYG-571_21` ของ PYG-649 เดิมเขียน `field_changes` แบบไม่ encode จึงไม่เจอบั๊กนี้ → เปลี่ยนเป็นรูปแบบจริง (JSON-stringified) แล้ว ยังผ่าน (เคสนั้นตรวจคำขอที่ยังรอ)

## 2. สรุป

| | จำนวน |
|---|---|
| PASS | 13 TC (20 รอบ) + AC5 (production) |
| FAIL | 1 → **PYG-667** |
| NOT RUN | 4 (หน้าจอ: กันส่งเมื่อไม่เลือก, ป้ายใน List, ป้ายใน Profile, มือถือ) |

## 3. รันซ้ำ

```bash
QA_DATABASE_URL=postgresql://postgres:qa@127.0.0.1:5436/<db> npm run test:e2e -- --runInBand test/pyg577
```
- harness เพิ่ม `KycModule`, `AdminModule`, `CaregiverPublicModule`, `SearchModule`
- CHECK ของ `profession` ตรวจบน production (DB ทิ้งได้สร้างจาก `schema.prisma` จึงไม่มี CHECK ที่เขียนมือ)
- เมื่อ PYG-667 แก้แล้ว: เปลี่ยน `it.failing` → `it` ใน `PYG-556_15`
