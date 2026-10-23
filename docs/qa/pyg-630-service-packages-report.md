# PYG-630 · QA ชุดบริการที่แนะนำตามกลุ่ม (S14 · PYG-567)

- การ์ด: PYG-630 (QA) · Story: PYG-567 · ขึ้นกับ: PYG-626 (contract), PYG-627 (DB), PYG-628 (BE), PYG-629 (FE), S09 · PYG-564 (กลุ่ม)
- Commit ที่ทดสอบ: `origin/dev` @ `b73d381` (merge #163 S14)
- รัน: 2026-10-23 · Created By / Execute By: Wasan. R
- Spec: `test/pyg630-service-packages.e2e-spec.ts` (GraphQL + REST เข้าแอปจริง ต่อ Postgres ทิ้งได้ใน Docker · ข้อมูลชุด = migration seed จริง `20261009030000`)
- **ผล: PASS 31 TC · FAIL 1 → PYG-690 (Medium) · NOT RUN (หน้าจอ) 3**

## 0. ต้นทางของ expected

- ตารางชุดที่อนุมัติ: PYG-627 (Sammy อนุมัติ 9 ต.ค. 2026) — ฝังเป็นค่าคงที่ใน spec ไม่อ่านจาก DB

| กลุ่ม | ชุด (ตามลำดับ) | บริการในชุด |
|---|---|---|
| ติดสังคม | companion_care · daily_care | เป็นเพื่อน+ดูแลทั่วไป · ดูแลทั่วไป+ยา+เป็นเพื่อน |
| ติดบ้าน | daily_care · rehab_care | ดูแลทั่วไป+ยา+เป็นเพื่อน · กายภาพ+ดูแลทั่วไป |
| ติดเตียง | bedridden_full · rehab_care | ติดเตียง+ยา · กายภาพ+ดูแลทั่วไป |

- กลุ่มจากคะแนน ADL (S09): 0–4 ติดเตียง · 5–11 ติดบ้าน · 12–20 ติดสังคม — คะแนนสร้างผ่านแบบประเมินจริง
- AC4 "ผู้ gate แก้ข้อมูล": จำลองด้วยการแก้แถวใน DB ทิ้งได้ (การ์ดห้ามแก้ข้อมูลจับคู่บน production เอง)

## 1. Test case sheet

### AC1 · AC2 · ชุดตามกลุ่ม
| TC | Verify that… | ผล |
|---|---|---|
| PYG-567_01 | ผู้สูงอายุมีกลุ่ม → ได้กลุ่ม + ชุดพร้อมชื่อ/คำอธิบาย ไทย-อังกฤษ และชื่อบริการทุกรายการ | PASS |
| PYG-567_02–07 | ADL 20/12 → ติดสังคม · 11/5 → ติดบ้าน · 4/0 → ติดเตียง ได้ชุดและบริการ **ตรงตาราง ตามลำดับ** | PASS 6/6 |
| PYG-567_08 | ไม่มีชุดของกลุ่มอื่นปน (ติดสังคมไม่เห็น bedridden_full/rehab_care · ติดเตียงไม่เห็น companion_care/daily_care) | PASS |
| PYG-567_09 | bedridden_full ไม่มีกายภาพ (กายภาพอยู่ชุดฟื้นฟูแยก) | PASS |
| PYG-567_10 | ส่งบริการที่เลือก (`physiotherapy`) → `containsSelectedServiceType` ถูกต่อชุด (daily=false · rehab=true) | PASS |
| PYG-567_11 | บริการที่ไม่รู้จัก (`elderly_care`) → `BAD_USER_INPUT` | PASS |
| — | หน้าจองแสดงส่วนชุดที่แนะนำ | NOT RUN (FE) |

### AC3 · เลือกนอกชุดได้ (R4 · E5)
| TC | Verify that… | ผล |
|---|---|---|
| PYG-567_12 | ไม่เลือกชุด เลือกบริการเอง → จองสำเร็จ บริการตรง | PASS |
| PYG-567_13 | บริการที่ไม่มีในชุดใดของกลุ่ม (ติดสังคมจอง `bedridden_care`) → จองสำเร็จ | PASS |
| PYG-567_14 | เอาบริการในชุดออก เหลือรายการเดียว → จองสำเร็จ | PASS |
| PYG-567_15 | **เลือกชุดที่มีหลายบริการแล้วจอง → booking มีครบทุกบริการที่เลือก** | **FAIL → PYG-690** (`it.failing`) — เก็บแค่บริการแรก |

**PYG-690 (Medium):** FE `buildBookingPayload` ส่ง `serviceType = serviceTypes[0]` · BE รับ/เก็บบริการได้ค่าเดียว (`bookings.service_type`) · เลือก `daily_care` (3 บริการ) แล้วจอง → booking เป็น `general_care` อย่างเดียว ราคาก็คิดจากบริการแรก · ขัด E5 "การจองยึดบริการที่เลือกจริง" · เสนอให้แก้ถาวรพร้อม S19 (PYG-672) ซึ่งให้เลือกบริการ ≥ 1 รายการอยู่แล้ว

### AC4 · แก้ข้อมูลโดยไม่ deploy (R3 · R6)
| TC | Verify that… | ผล |
|---|---|---|
| PYG-567_16 | เพิ่มแถวจับคู่ (ติดสังคม → rehab_care, sort 5) → คำแนะนำเปลี่ยนทันที ตามลำดับใหม่ | PASS |
| PYG-567_17 | ปิดการจับคู่ (ติดสังคม × daily_care) → หายเฉพาะกลุ่มนั้น ติดบ้านยังเห็น | PASS |
| PYG-567_18 | ปิดชุด (rehab_care) → หายจากทุกกลุ่ม | PASS |
| PYG-567_19 | เพิ่มบริการในชุด → รายการบริการเปลี่ยนตาม | PASS |
| PYG-567_20 | E2 · กลุ่มไม่มีการจับคู่ที่เปิดอยู่ → `{ careGroup: BEDRIDDEN, packages: [] }` ไม่ error | PASS |
| PYG-567_21 | E8 · ตารางชุดว่างทั้งหมด → ได้กลุ่ม + รายการว่าง · จองได้ | PASS |
| PYG-567_22 | E7 · ชุดที่เลือกถูกปิดก่อนยืนยัน → จองไม่พัง บริการตามที่เลือก | PASS |

### AC5 · E1 · E3
| TC | Verify that… | ผล |
|---|---|---|
| PYG-567_23 | ประเมินใหม่ ADL 20 → 3 → ได้ชุดติดเตียง · booking ที่สร้างก่อนหน้า (บริการ ผู้รับบริการ ราคา) ไม่เปลี่ยน (R7) | PASS |
| PYG-567_24 | E1 · ยังไม่มีผลประเมิน → `{ careGroup: null, packages: [] }` ไม่ error | PASS — ดูหมายเหตุ |
| PYG-567_25 | E3 · บัญชีเดียว 2 คนต่างกลุ่ม → แต่ละคนได้ชุดของตัวเอง | PASS |
| — | E3 สลับคนในหน้าจองแล้วชุดที่เลือกของคนเดิมไม่ติดมา | NOT RUN (FE) — โค้ด FE ใช้ `key={careRecipientId}` remount |

**หมายเหตุ E1:** story เขียนว่า "หน้าจองยังใช้ได้ตามปกติ" — ส่วนชุดที่แนะนำทำงานถูก (ว่าง ไม่ error) แต่ **ยืนยันการจองไม่ได้** เพราะด่าน S08 (`ASSESSMENT_REQUIRED` 422) บังคับประเมินก่อนจอง ซึ่งเป็นกติกาของ S08 ไม่ใช่ข้อบกพร่องของ S14 · ถ้าทีมต้องการให้ E1 จองได้จริงต้องเคาะกับ S08

### สิทธิ์ (R8) · เรียก API ตรง
| TC | Verify that… | ผล |
|---|---|---|
| PYG-567_26 | ผู้ใช้ A ขอของผู้สูงอายุของผู้ใช้ B → `ASSESSMENT_ACCESS_DENIED` ไม่มีข้อมูลรั่ว | PASS |
| PYG-567_27 | ไม่ล็อกอิน → `UNAUTHENTICATED` | PASS |
| PYG-567_28 | role Caregiver → `ASSESSMENT_ACCESS_DENIED` | PASS |
| PYG-567_29 | สมาชิกกลุ่มครอบครัว ACTIVE อ่านได้ · ถูกถอดออกจากกลุ่มแล้วอ่านไม่ได้ | PASS |
| PYG-567_30 | id ไม่ใช่ UUID / ผู้สูงอายุถูกลบ → ปฏิเสธแบบเดียวกับ id ของคนอื่น | PASS |

### ข้อมูลหลัง migration (query ใน PYG-627)
| TC | Verify that… | ผล |
|---|---|---|
| PYG-567_31 | 4 ชุด · 9 บริการ · กลุ่มละ 2 การจับคู่ | PASS |
| PYG-567_32 | รัน seed ซ้ำ → จำนวนเท่าเดิม (ON CONFLICT DO NOTHING) | PASS |

### หน้าจอ (ยังไม่ได้รัน)
| เคส | ผล |
|---|---|
| ส่วนชุดโหลดไม่สำเร็จ ยังจองต่อได้ | NOT RUN — โค้ด FE: ไม่รายงาน stepMissing ไม่กันปุ่มถัดไป |
| การ์ดชุดไม่ล้นที่ความกว้างมือถือ | NOT RUN |

## 2. สิ่งที่ยังไม่ได้ทดสอบ

- หน้าจอ FE ทั้งหมด (3 แถว NOT RUN ข้างบน)
- production: deploy ตอนนี้ใช้ฐาน `payung-prod-db` (Hyperdrive) ผมไม่มีสิทธิ์อ่าน → ยังไม่ได้รัน query ตรวจของ PYG-627 บน production
- E4 (กลุ่มเปลี่ยนกลางการจอง) และ E6 เป็นประเด็นให้เคาะใน story ไม่มี expected

## 3. รันซ้ำ

```bash
npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script > /tmp/qa.sql
# สร้าง DB ทิ้งได้บน localhost แล้ว psql -f /tmp/qa.sql
QA_DATABASE_URL=postgresql://…@127.0.0.1:…/qa630 DATABASE_URL=$QA_DATABASE_URL \
  npm run test:e2e -- --runInBand --runTestsByPath test/pyg630-service-packages.e2e-spec.ts
```

harness (`test/support/qa-e2e.ts`) เพิ่ม `ServicePackageModule` ในการ์ดนี้ · spec อยู่ใน CI `qa-e2e` แล้ว
· ผลข้างเคียง: `PYG-564_13` (QA S09) ตรวจว่า type ไหนมี `careGroup` → เพิ่ม `RecommendedServicePackages` ในรายการที่อนุญาต ตรงกับ `src/common/care-group-contract.spec.ts` ที่ PR #163 อนุญาตไว้แล้ว
