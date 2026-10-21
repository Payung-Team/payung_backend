# PYG-589 · QA ใบประกอบวิชาชีพใน KYC (S03 · PYG-558)

- การ์ด: PYG-589 (QA) · Story: PYG-558 · ขึ้นกับ: PYG-585 (contract), PYG-586 (DB), PYG-587 (BE), PYG-588 (FE)
- Commit ที่ทดสอบ: `origin/dev` @ `e75a3c0`
- รัน: 2026-10-21 · Created By / Execute By: Wasan. R
- Spec: `test/pyg589-license.e2e-spec.ts` (GraphQL เข้าแอปจริง ต่อ Postgres ทิ้งได้ใน Docker) + query อ่านอย่างเดียวบน production
- **ผล: PASS 31 TC (42 รอบใน spec + 1 บน production) · FAIL 2 → PYG-669 (High), PYG-670 (Medium) · BLOCKED 3 · NOT RUN (หน้าจอ) 6**

## 0. ต้นทางของ expected และวิธีทดสอบ

- story PYG-558: R1–R7, E1–E11 · contract PYG-585: error code 422 (`code` = ช่องแรก, `codes` = ทุกช่องที่ขาด)
- "วันนี้" = ปฏิทินไทย: ตั้งนาฬิกาเซิร์ฟเวอร์ด้วย `ClockService` ปลอมของ harness (ไม่แก้นาฬิกาเครื่อง ไม่รอข้ามวัน)
- งานหมดอายุรายวัน: เรียก `LicenseExpiryCron.run()` ตรง ๆ หลังเลื่อนนาฬิกา (= วิธีทดสอบงานตั้งเวลาโดยไม่รอข้ามวันจริง)
- ไฟล์: แค่ storage path ในโฟลเดอร์ของผู้ใช้ทดสอบ ไม่มีไฟล์จริง ไม่มีเอกสารของบุคคลจริง · signed URL มาจาก storage จำลองของ harness (บันทึก bucket/path ที่ถูกขอ)
- แจ้งเตือน: ตรวจแถวใน `notifications` (in-app) — ช่องทางอื่น (อีเมล/SMS) ยังไม่เคาะ

## 1. Test case sheet

### AC1 · พยาบาล/นักกายภาพฯ ต้องมีเลขและไฟล์
| TC | Verify that… | ผล |
|---|---|---|
| PYG-558_01 ×2 (E10) | พยาบาล / นักกายภาพฯ ส่ง KYC โดยไม่มีไฟล์ใบ → `LICENSE_FILE_REQUIRED` (422) · ไม่มีแถว `caregivers` | PASS 2/2 |
| PYG-558_02 ×3 (E5) | อัปโหลดใบโดยเลข ไม่ส่ง / `""` / มีแต่ช่องว่าง → `LICENSE_NUMBER_REQUIRED` · ไม่มีแถวเอกสาร | PASS 3/3 |
| PYG-558_03 ×2 | กรอกครบแล้วส่งได้ ทั้ง 2 วิชาชีพ · KYC `pending` · ใบผูกกับผู้ดูแล สถานะ `pending` | PASS 2/2 |
| PYG-558_04 (E10) | แถวใบแบบ client เก่า (ไม่มีเลข/วันหมดอายุ) ใช้ส่ง KYC ไม่ได้ → `LICENSE_NUMBER_REQUIRED` + `codes` ครบ 2 ช่อง | PASS |
| — | หน้าจอกันการส่ง | NOT RUN (FE) |

### AC2 · ผู้ดูแลทั่วไปไม่ถูกบังคับ
| TC | Verify that… | ผล |
|---|---|---|
| PYG-558_05 (E11) | ผู้ดูแลทั่วไปส่ง KYC ได้โดยไม่มีใบ · `kycStatus.license = null` | PASS |
| — | ผู้ดูแลทั่วไปไม่เห็นส่วนใบประกอบฯ บนหน้าจอ | NOT RUN (FE) |

### AC3 · วันหมดอายุ
| TC | Verify that… | ผล |
|---|---|---|
| PYG-558_06 | ไม่ระบุวันหมดอายุ → `LICENSE_EXPIRY_REQUIRED` | PASS |
| PYG-558_07 ×3 (E3) | เมื่อวาน / วันนี้ / วันนี้ 23:30 → `LICENSE_EXPIRY_NOT_FUTURE` · ไม่มีแถว | PASS 3/3 |
| PYG-558_08 ×2 | พรุ่งนี้ (ส่งเป็น ISO และ `YYYY-MM-DD`) ผ่าน · เก็บเป็นสิ้นวันเวลาไทย 23:59:59.999+07 | PASS 2/2 |
| PYG-558_09 | ขาดเลข + วันหมดอายุย้อนหลัง → ตอบครบทั้ง 2 ใน `codes` | PASS |
| PYG-558_10 (E4) | 00:30 เวลาไทย (ยังเป็นเมื่อวานใน UTC): วันนี้ถูกปฏิเสธ พรุ่งนี้ผ่าน | PASS |
| PYG-558_11 (E4) | 23:50 เวลาไทย: พรุ่งนี้ผ่าน | PASS |
| PYG-558_12 (E5) | ช่องว่างหัวท้ายถูกตัดก่อนบันทึก | PASS |

### AC4 · หน้า KYC review
| TC | Verify that… | ผล |
|---|---|---|
| PYG-558_13 ×2 | `adminKycDetail` แสดงวิชาชีพ เลข (ตัดช่องว่างแล้ว) ชื่อไฟล์ วันหมดอายุ สถานะ และ signed URL จาก bucket `kyc-documents` ตาม path ของเจ้าของ ทั้งพยาบาลและนักกายภาพฯ | PASS 2/2 (ข้อมูล API) |
| — | หน้า review แสดงและเปิดไฟล์ได้จริง | NOT RUN (FE) |

### AC5 + AC6 · อนุมัติ / ปฏิเสธ และแจ้งเตือน
| TC | Verify that… | ผล |
|---|---|---|
| PYG-558_14 | อนุมัติ → `approved` · `kyc_reviews` = `license_approved` + ผู้ตรวจ · แจ้งเตือน `license_approved` 1 รายการถึงผู้ดูแลคนนั้นเท่านั้น | PASS |
| PYG-558_15 | ปฏิเสธพร้อมเหตุผล → `rejected` · เหตุผล (ตัดช่องว่าง) อยู่ใน `kyc_reviews` · แจ้งเตือนมีเหตุผล · ผู้ดูแลเห็น `rejectionReason` · คนอื่นไม่ได้แจ้งเตือน | PASS |
| PYG-558_16 ×3 | ปฏิเสธโดยเหตุผล `null` / `""` / ช่องว่าง → `LICENSE_REJECT_REASON_REQUIRED` · ไม่เปลี่ยนสถานะ ไม่มีประวัติ ไม่แจ้งเตือน | PASS 3/3 |
| PYG-558_17 | ใบที่ตัดสินแล้วตัดสินซ้ำไม่ได้ (สถานะเดิมคงอยู่) | PASS |
| — | หน้าจอกันปฏิเสธโดยไม่มีเหตุผล | NOT RUN (FE) |
| — | แจ้งเตือนช่องทางอื่นนอกจาก in-app (อีเมล / SMS) | BLOCKED — story ยังไม่เคาะช่องทาง |

### AC7 · หมดอายุ
| TC | Verify that… | ผล |
|---|---|---|
| PYG-558_18 (E8) | งานรายวันรัน 2 ครั้งวันเดียวกัน: ใบ pending และ approved ที่ถึงวันหมดอายุ → `expired` · แจ้งเตือน `license_expired` ครั้งเดียว · ใบที่ยังไม่ถึงวันและใบที่ถูกปฏิเสธไม่ถูกแตะ · ผู้ดูแลเห็น `expired` / `isExpired` | PASS |
| PYG-558_19 (E8) | งานไม่ได้รันหลายวัน → รอบถัดไปเก็บใบของวันที่ข้ามไปครบ | PASS |
| PYG-558_20 | ใบของผู้ดูแลที่วิชาชีพไม่บังคับใบแล้ว ไม่ถูกเปลี่ยน ไม่แจ้งเตือน | PASS |
| PYG-558_21 (R7) | **ผู้ดูแลที่ verified แล้ว ใบหมดอายุ อัปโหลดใบใหม่ → ใบใหม่รอตรวจ และแอดมินเห็น** | **FAIL → PYG-669** (`it.failing`) |
| PYG-558_32 | ทางเดียวที่ผูกใบใหม่ให้ผู้ดูแล verified (`requestProfessionChange`) ใช้ต่ออายุวิชาชีพเดิมไม่ได้ → `PROFESSION_UNCHANGED` | PASS (หลักฐานของ PYG-669) |

**PYG-669:** `uploadKycDocument` ไม่ผูก `caregiver_id` ให้ใบประกอบฯ (ใบขับขี่ผูก) · ใบผูกได้แค่ตอน `submitKyc` ซึ่งผู้ดูแล verified ส่งซ้ำไม่ได้ · `loadDocs` อ่านด้วย `caregiver_id` → ใบใหม่ไม่โผล่ทั้ง `kycStatus` และ `adminKycDetail` · FE มีทางอัปโหลดใบแค่ฟอร์ม KYC กับฟอร์มขอเปลี่ยนวิชาชีพ → **พยาบาล/นักกายภาพฯ ต่ออายุใบไม่ได้เลย** และเสียงานที่ล็อกวิชาชีพถาวรหลังใบแรกหมดอายุ (ยังไม่กระทบ production: มีพยาบาล 1 คน ใบ pending 1 ใบ)

### Edge cases
| TC | Verify that… | ผล |
|---|---|---|
| PYG-558_22 (E1) | เปลี่ยนเป็นผู้ดูแลทั่วไปหลังกรอกใบแล้วยังส่งได้ | PASS · ผลต่อใบที่กรอกค้าง: **BLOCKED** (ยังไม่เคาะ) — ปัจจุบันระบบ **เก็บ** ใบไว้ ผูกกับผู้ดูแล สถานะ `pending` และแสดงใน `kycStatus` |
| PYG-558_23 (E2) | **resubmit จากพยาบาลเป็นนักกายภาพฯ ด้วยใบพยาบาลเดิม ต้องถูกปฏิเสธ** | **FAIL → PYG-670** (`it.failing`) — ผ่านได้ เพราะใบไม่บันทึกว่าแนบเพื่อวิชาชีพไหน |
| PYG-558_24 (E6) | ใบถูกปฏิเสธแล้วใช้ส่งซ้ำไม่ได้ · ใบใหม่เข้าคิว `pending` และผูกกับผู้ดูแล · ใบเก่ายัง `rejected` · ประวัติการปฏิเสธเดิมอยู่ครบ · หน้า review เห็นใบใหม่ | PASS |
| PYG-558_25 (E7) | ใบหมดอายุระหว่างรอตรวจ → อนุมัติไม่ได้ `LICENSE_EXPIRED` · ยัง `pending` · ไม่แจ้งเตือน · หน้า review `isExpired = true` | PASS |
| PYG-558_26 (E9) | ผู้ดูแลทั่วไปส่งใบมาเองผ่าน API | ส่งได้ · ใบถูกเก็บ `pending` · ควรรับหรือปฏิเสธ: **BLOCKED** (ยังไม่เคาะ) |

### สิทธิ์
| TC | Verify that… | ผล |
|---|---|---|
| PYG-558_27 | ผู้ดูแล A ลงทะเบียนไฟล์ในโฟลเดอร์ storage ของ B ไม่ได้ | PASS |
| PYG-558_28 | A ใช้ใบของ B ส่ง KYC ไม่ได้ (NotFound 404 "not owned by user" · ไม่มีแถวผู้ดูแลของ A · ใบของ B ไม่ถูกย้าย) · A อ่าน `adminKycDetail` ของ B → `FORBIDDEN` | PASS |
| PYG-558_29 | ผู้ดูแลอนุมัติ/ปฏิเสธใบของตัวเอง → `FORBIDDEN` | PASS |
| PYG-558_30 | Elder อนุมัติ / ปฏิเสธ / เปิดหน้า review → `FORBIDDEN` | PASS |
| PYG-558_31 | ไม่ล็อกอิน: อนุมัติ / อ่านหน้า review / อัปโหลด → `UNAUTHENTICATED` | PASS |
| PYG-558_33 | **production**: bucket `kyc-documents` เป็น private (`public = false`) → เปิดลิงก์ไฟล์โดยไม่มี signed URL ไม่ได้ | PASS |
| — | ป้าย/ฟอร์มไม่ล้นที่ความกว้างมือถือ | NOT RUN (FE) |

หมายเหตุ PYG-558_28: ด่านแรกที่จับได้คือ "เอกสารต้องเป็นของผู้ส่ง" (Nest `NotFoundException`) ซึ่งใน GraphQL ของ repo นี้ออกเป็น `code: INTERNAL_SERVER_ERROR` + `extensions.status: 404` — ปฏิเสธถูกต้องและไม่รั่วข้อมูล แต่ code ไม่สื่อความหมาย (แบบเดียวกับ NotFound ทุกตัวใน repo ไม่ใช่เฉพาะ S03)

## 2. ผลตรวจ production (อ่านอย่างเดียว · 2026-10-21)

| รายการ | ค่า |
|---|---|
| คอลัมน์ `kyc_documents.license_number` (text), `expires_at` (timestamptz), `review_status`, `reviewed_at` | มีครบ |
| CHECK `review_status` | `pending`, `approved`, `rejected`, `expired` |
| enum `NotificationType` | มี `license_approved`, `license_rejected`, `license_expired` (และ `job_type_removed`) |
| ใบประกอบฯ ทั้งหมด | 1 ใบ `pending` · ไม่มีใบที่ขาดเลข/วันหมดอายุ · ไม่มีใบที่ยังใช้อยู่แต่เลยวันหมดอายุ |
| ผู้ดูแลตามวิชาชีพ | general_caregiver 93 · nurse 1 (E11: ผู้ดูแลเดิมทุกคนเป็นทั่วไป ไม่ถูกบังคับย้อนหลัง) |
| แจ้งเตือน `license_*` ที่ส่งแล้ว | 0 |
| bucket `kyc-documents` | private |

ข้อสังเกต: คอมเมนต์ใน `notification-type.enum.ts` ยังบอกว่า `license_*` "ยังไม่มีใน Prisma enum / DB" — ล้าสมัยแล้ว (มีทั้งใน `schema.prisma` และ production) ไม่ใช่บั๊ก

ข้อสังเกตต่อการ deploy: branch `origin/deploy` (Cloudflare Worker) ถอด `triggers.crons` ออก ณ 2026-10-21 → `LicenseExpiryCron` จะไม่รันบน production จนกว่าจะใส่ cron กลับ (AC7 ทำงานไม่ได้บน production ระหว่างนั้น)

## 3. สรุป

| ผล | จำนวน |
|---|---|
| PASS | 31 TC (spec 32 TC / 42 รอบ ลบ FAIL 2 + PYG-558_33 บน production) |
| FAIL | 2 → **PYG-669** (High · ต่ออายุใบไม่ได้), **PYG-670** (Medium · ใช้ใบเดิมข้ามวิชาชีพ) |
| BLOCKED | 3 — ช่องทางแจ้งเตือนนอก in-app, E1 (เก็บ/ทิ้งใบ), E9 (รับ/ปฏิเสธใบของผู้ดูแลทั่วไป) |
| NOT RUN | 6 (หน้าจอ: กันส่ง KYC, ซ่อนส่วนใบของผู้ดูแลทั่วไป, กันวันหมดอายุ, หน้า review, กันปฏิเสธไม่มีเหตุผล, มือถือ) |

## 4. หลักฐานและหมายเหตุการรัน

```
QA_DATABASE_URL=postgresql://postgres:qa@127.0.0.1:5436/<db> npm run test:e2e -- --runInBand test/pyg589
```
- เวอร์ชันสุดท้ายรัน 2 รอบติด: 42/42 ทุกรอบ (รวม `it.failing` 2 เคสที่ "ผ่าน" เพราะบั๊กยังอยู่)
- harness (`test/support/qa-e2e.ts`) เพิ่มแบบ opt-in: `SUPABASE_URL` ค่าปลอม + `enableStorage()` / `signedUrlCalls` (signed URL จำลอง) — ชุดอื่นที่ไม่เรียก `enableStorage()` ยังได้ error เดิมเมื่อแตะ Supabase admin client
- ts-jest คอมไพล์ใหม่ ~10–15 นาทีทุกครั้งที่ harness/spec เปลี่ยน (cache เย็น) · ตัวเทสใช้ 5–10 วินาที
- เมื่อแก้ PYG-669 / PYG-670 แล้ว: เปลี่ยน `it.failing` → `it` ใน `PYG-558_21` / `PYG-558_23`
- ไม่มีการเขียนข้อมูลบน production
