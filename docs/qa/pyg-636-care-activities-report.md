# PYG-636 · QA รายการกิจกรรมกลาง การปิดใช้งาน และการเลือกตอนจอง (S15 · PYG-568)

- การ์ด: PYG-636 (QA) · Story: PYG-568 · ขึ้นกับ: PYG-633 (DB), PYG-634 (BE · #140), PYG-635 (FE · FE #43), PYG-651 (seed T-01 + taxonomy)
- Commit ที่ทดสอบ: `origin/dev` @ `83ccd4d` (รวม #144 ลำดับ required skills แล้ว)
- รัน: 2026-10-20 · Created By / Execute By: Wasan. R
- Spec: `test/pyg636-care-activities.e2e-spec.ts` · harness ร่วม: `test/support/qa-e2e.ts` · CI: `.github/workflows/qa-e2e.yml`
- **ผล: API/DB 38/38 PASS (35 TC · _02 มี 3 ค่า, _12 มี 2 ค่า) · AC6 ส่วน "ไม่เปลี่ยนระดับ booking" = BLOCKED (S16 ยังไม่มีโค้ดคำนวณ) · เคสหน้าจอ (FE) 4 เคส = NOT RUN (ไม่ได้ทำแบบอัตโนมัติ)**
- ไม่พบบั๊ก → ไม่มี bug card

**รันจริงแค่ไหน:** บูต FamilyGroup → Booking → Payment / Monitoring / Notification / Consent / CareActivity + Assessment + CareSkill ตัวจริง ยิง GraphQL (แอดมิน, รายการ, จองแทน, รายละเอียดการจอง) และ REST `POST /api/v1/bookings` ต่อ Postgres 17 ทิ้งได้ใน Docker ที่สร้างจาก `schema.prisma` · mock แค่ Supabase auth / Omise / Email · ข้อมูลเริ่มต้นได้จากการรัน migration ข้อมูลของ S15 ตามลำดับเดียวกับ production

**ข้อมูลทดสอบ:** กิจกรรมที่เทสเพิ่มชื่อขึ้นต้นด้วย `[QA-636]` หมวด `[QA-636] หมวดทดสอบ` — อยู่ใน DB ทิ้งได้เท่านั้น **ไม่ได้เขียนอะไรลง production** (production อ่านอย่างเดียว §3)

## 1. Test case sheet

ทุกเคส: ขั้นที่ 1 = เตรียมข้อมูล (แอดมิน/ผู้จอง/ผู้ดูแล/ผู้รับบริการที่มีแบบประเมิน ADL แล้ว) · expected ตรงกับขั้นแบบ 1:1

### AC1 · หมวดและระดับ
| TC | Verify that… | ขั้นตอน → expected | ผล |
|---|---|---|---|
| PYG-568_01 | every activity in the list has a category and one of the 3 levels | 1. ผู้จองเรียก `careActivities` → ได้รายการ > 0 · 2. ตรวจทุกแถว → หมวดไม่ว่าง ระดับ ∈ BASIC/INTERMEDIATE/ADVANCED | PASS (58 แถว) |
| PYG-568_02 ×3 | an admin can add an activity at level BASIC / INTERMEDIATE / ADVANCED | 1. แอดมิน `createCareActivity` ระดับนั้น → สำเร็จ · 2. ผลตอบ → ระดับตรง, `isActive=true`, `code=null` | PASS 3/3 |
| PYG-568_03 | a level outside the 3 values is rejected and nothing is written | 1. ส่งระดับ `EXPERT` / `"basic "` / `""` / `ระดับสูง` → `CARE_ACTIVITY_INVALID` `field=careLevel` ทั้ง 4 · 2. นับแถว → เท่าเดิม | PASS |

### AC2 · ข้อมูลเริ่มต้นตรงกับ T-01
| TC | Verify that… | ขั้นตอน → expected | ผล |
|---|---|---|---|
| PYG-568_04 | the T-01 source file matches the checksum recorded in the seed migration | 1. อ่าน `docs/pyg568-t01-phase-pilot-20261008.csv` → 43 แถว · 2. md5 (`code\|name\|category\|level` เรียงตาม code) → `360b8f34…11a4` ตรงกับคอมเมนต์ใน migration | PASS |
| PYG-568_05 | every seeded activity matches T-01 (+ PYG-651) by name, category and level, nothing extra or missing | 1. รัน migration ข้อมูล 3 ไฟล์ · 2. เทียบทีละแถวกับ CSV + การเปลี่ยนแปลงของ PYG-651 (ระดับ 8 · ชื่อ 3 · เพิ่ม 15 · ชื่อย่อ E11) ที่เขียนแยกจาก SQL → ตรงทุกแถว 58 แถว | PASS |
| PYG-568_06 | the total and per-category counts match | 1. นับต่อหมวด → ตรงกับที่คาด 12 หมวด | PASS |

> T-01 ที่ใช้เทียบ = ร่าง 8 ต.ค. 2026 (Phase ทดลอง อนุมัติโดย Sammy) ซึ่ง **อาจารย์ยังไม่ได้ตรวจ** (ตามหมายเหตุใน migration) — ถ้าอาจารย์แก้ ต้องรันเคสนี้ซ้ำกับตารางใหม่

### AC3 · แอดมินจัดการรายการ
| TC | Verify that… | ขั้นตอน → expected | ผล |
|---|---|---|---|
| PYG-568_07 | an admin can add an activity and it appears in the booking list | 1. เพิ่ม → สำเร็จ · 2. ผู้จองเรียก `careActivities` → มีชื่อนั้น | PASS |
| PYG-568_08 | an admin can edit the name, category and level | 1. เพิ่ม · 2. `updateCareActivity` ชื่อ+หมวด+ระดับ → ผลตอบค่าใหม่ · 3. ตรวจ DB → `care_level=advanced` ค่าใหม่ครบ | PASS |
| PYG-568_09 | an admin can deactivate and reactivate | 1. ปิด → `isActive=false` · 2. เปิด → `isActive=true` | PASS |
| PYG-568_10 | a duplicate name in the same category returns `CARE_ACTIVITY_DUPLICATE` | 1. เพิ่มชื่อ X · 2. เพิ่ม X หมวดเดิม → `DUPLICATE` พร้อม `category`, `nameTh` · 3. นับแถว → เท่าเดิม · 4. X ต่างหมวด → สำเร็จ | PASS |
| PYG-568_11 | renaming into an existing name in the same category returns `CARE_ACTIVITY_DUPLICATE` | 1. เพิ่ม ก, ข · 2. แก้ ข เป็นชื่อ ก → `DUPLICATE` | PASS |
| PYG-568_12 ×2 | a blank required field (nameTh / category) is rejected and nothing is written | 1. ชื่อเป็นช่องว่าง / หมวดว่าง → `CARE_ACTIVITY_INVALID` `reason=required` ตรง field · 2. นับแถว → เท่าเดิม | PASS 2/2 |
| PYG-568_13 | a missing required field is rejected by the API schema | 1. ไม่ส่ง `careLevel` → GraphQL validation error, `data=null` | PASS |
| PYG-568_14 | a name longer than 200 characters is rejected | 1. ชื่อ 201 ตัว → `INVALID` `reason=too_long max=200` | PASS |
| PYG-568_15 | editing an unknown id returns `CARE_ACTIVITY_NOT_FOUND` | 1. แก้ id สุ่ม → `NOT_FOUND` | PASS |
| PYG-568_16 | the admin list filters by category, level, status and search | 1. เพิ่มแล้วปิด · 2. ค้นชื่อ → เจอตัวเดียว · 3. หมวด+ระดับ+ปิด → เจอ · 4. หมวด+เปิด → ไม่เจอ · 5. ค้นรหัส `A01` → A01 ตัวเดียว | PASS |

### AC4 · ปิดใช้งาน
| TC | Verify that… | ขั้นตอน → expected | ผล |
|---|---|---|---|
| PYG-568_17 | a deactivated activity is not offered for new bookings | 1. เพิ่ม → อยู่ใน `careActivities` · 2. ปิด → หายจาก `careActivities` · 3. `adminCareActivities` → ยังเห็น `isActive=false` | PASS |
| PYG-568_18 | a booking made before deactivation still shows the original name and level | 1. จองพร้อมกิจกรรม → 201 · 2. ปิดกิจกรรม · 3. `myBooking.activities` → ชื่อ หมวด ระดับเดิมครบ | PASS |
| PYG-568_19 | booking (REST) with a deactivated activity → 422 `CARE_ACTIVITY_INACTIVE`, no booking | 1. ปิด · 2. `POST /bookings` → 422 `{code, activityIds:[id]}` · 3. นับ bookings → เท่าเดิม | PASS |
| PYG-568_20 | booking with an unknown activity id → `CARE_ACTIVITY_NOT_FOUND`, no booking | 1. id สุ่ม → 422 `NOT_FOUND` · 2. นับ → เท่าเดิม | PASS |
| PYG-568_21 | booking on behalf (GraphQL) with a deactivated activity → `CARE_ACTIVITY_INACTIVE`, no booking | 1. ปิด · 2. เจ้าของกลุ่ม `createBookingOnBehalf` ให้สมาชิก → `INACTIVE` · 3. นับ → เท่าเดิม | PASS |

### AC5 · เลือกตอนจอง
| TC | Verify that… | ขั้นตอน → expected | ผล |
|---|---|---|---|
| PYG-568_22 | the booking list has only active activities, grouped by category, sort order ascending in each group | 1. `careActivities` → ทุกแถว active · 2. แต่ละหมวดเป็นก้อนเดียวติดกัน · 3. ในหมวด `sortOrder` ไม่ลดลง | PASS |
| PYG-568_23 | a booking with several activities saves all of them with name, category and level | 1. จองด้วย A04 E04 H01 → 201 + `activities` 3 ตัวในผลตอบ · 2. `booking_activities` → 3 แถว สำเนาชื่อ/หมวด/ระดับตรงกับต้นทาง | PASS |
| PYG-568_24 | the booking detail shows the chosen activities to both the booker and the caregiver | 1. จองด้วย B01 · 2. `myBooking.activities` → ตรง · 3. ผู้ดูแล `caregiverBooking.activities` → ตรง | PASS |

### AC6 · งานพิมพ์เอง
| TC | Verify that… | ขั้นตอน → expected | ผล |
|---|---|---|---|
| PYG-568_25 | typed tasks only → succeeds and saves no activity | 1. จองด้วย `tasks` อย่างเดียว → 201 · 2. `booking_activities` → 0 · 3. `myBooking` → `tasks` มี, `activities=[]` | PASS |
| PYG-568_26 | activities and typed tasks are kept separate | 1. จองด้วยทั้งคู่ → 201 · 2. `tasks` = งานพิมพ์เอง · `activities` = กิจกรรม · 3. งานพิมพ์เองไม่อยู่ใน `booking_activities` (ไม่มีระดับ) | PASS |
| PYG-568_27 | typed tasks do not set a booking level | 1. จองด้วยงานพิมพ์เอง "ฉีดยา" → `bookings.required_level` = NULL | **BLOCKED (บางส่วน)** — ผ่านเท่าที่ตรวจได้ แต่ **ไม่มีโค้ดใดเขียน `required_level` เลย** (S16 · PYG-569 ยังไม่ทำ) จึงพิสูจน์ไม่ได้ว่า "ไม่เปลี่ยน" ต้องรันซ้ำเมื่อ S16 เสร็จ |

### Edge cases
| TC | Verify that… | ขั้นตอน → expected | ผล |
|---|---|---|---|
| PYG-568_28 (E1) | renaming / re-levelling an activity in use does not change existing bookings | 1. จอง · 2. แก้ชื่อ+ระดับ · 3. `myBooking` → ชื่อและระดับเดิม | PASS |
| PYG-568_29 (E2) | deactivating after it was picked rejects the confirm and keeps the rest of the request usable | 1. โหลดรายการ (ยังเปิด) · 2. แอดมินปิด · 3. จองด้วย [ตัวที่ยังเปิด, ตัวที่ปิด] + งานพิมพ์เอง → 422 `INACTIVE activityIds=[ตัวที่ปิด]` (บอกเฉพาะตัวที่ปิด) · 4. ส่งซ้ำแบบที่ FE ทำ (ตัด id นั้นออก ข้อมูลอื่นเดิม) → 201 งานพิมพ์เองครบ | PASS |
| PYG-568_30 (E4) | a reactivated activity is offered again | 1. ปิด · 2. เปิด → กลับมาใน `careActivities` · 3. จอง → 201 | PASS |
| PYG-568_31 (E8) | duplicated `activityIds` are saved once | 1. ส่ง id เดิม 3 ครั้ง → 201 · 2. `booking_activities` → 1 แถว | PASS |
| PYG-568_32 (E9) | a booking without `activityIds` still succeeds | 1. ไม่ส่ง → 201 `activities=[]` | PASS |
| PYG-568_33 | an elder and a caregiver cannot add, edit or deactivate activities | 1. ผู้จอง/ผู้ดูแล เรียก create / update / setActive / adminCareActivities → `FORBIDDEN` ทุกตัว · 2. นับแถว → เท่าเดิม · 3. A04 ไม่ถูกแก้/ปิด | PASS |
| PYG-568_34 | an unauthenticated caller cannot use the admin API or the booking list | 1. ไม่มี token → `UNAUTHENTICATED` ทั้ง create / setActive / adminCareActivities / careActivities · 2. A04 ยังเปิด | PASS |
| PYG-568_35 (E5) | with no active activity the list is empty and a typed-task booking still works | 1. ปิดทุกตัว → `careActivities=[]` · 2. จองด้วยงานพิมพ์เอง → 201 · 3. เปิดคืน | PASS |

### ไม่ได้ทดสอบ (FE — ต้องทดสอบด้วยมือบนเบราว์เซอร์)
| TC | Verify that… | ผล |
|---|---|---|
| PYG-568_36 | the booking page shows active activities grouped by category with a level badge (AC5) | NOT RUN — ข้อมูลที่หน้าจอใช้ (ลำดับ/การจัดกลุ่ม) ผ่านแล้วที่ _22 |
| PYG-568_37 | E2 on screen: the message shows, the list reloads, other booking data is kept | NOT RUN — ฝั่ง API ผ่านที่ _29 |
| PYG-568_38 | a non-admin opening `/admin/care-activities` directly is blocked | NOT RUN — route อยู่ใต้ `RoleRoute` เดียวกับหน้าแอดมินอื่น (อ่านโค้ด) · API กันแล้วที่ _33/_34 |
| PYG-568_39 | long activity names do not overflow at mobile width | NOT RUN |

## 2. สรุปผล

| | จำนวน |
|---|---|
| PASS | 34 TC (38 รอบรวมค่าย่อย) |
| BLOCKED | 1 TC (_27 รอ S16) |
| NOT RUN (FE) | 4 TC (_36–_39) |
| FAIL | 0 |

## 3. ตรวจ production (อ่านอย่างเดียว · 2026-10-20) — query ของ PYG-633

| ตรวจ | ผล |
|---|---|
| จำนวน `care_activities` | 58 · ปิดใช้งาน 0 · แอดมินเพิ่มเอง (code ว่าง) 0 |
| md5 ของ `code\|name_th\|category\|care_level` (ที่มี code) | `8f484e82e4adfeb93ea2ba870a9e78e3` = **ตรงกับ DB ทดสอบที่ผ่าน _05 ทุกตัวอักษร** |
| จำนวนต่อหมวด × ระดับ | 29 กลุ่ม ตรงกับที่คาด |
| `booking_activities` | 0 แถว (ยังไม่มีการจองใหม่ตั้งแต่ 26 ก.ย.) |
| `care_activity_professions` (ล็อกวิชาชีพ PYG-651) | 16 แถว ตรงกับ migration |
| INSERT ระดับ `expert` ใน DO block แล้ว rollback | ถูกปฏิเสธด้วย `check_violation` (`care_activities_care_level_check`) |
| constraint | `care_level_check` ทั้งสองตาราง · `category_name_unique` · `booking_activities_unique` · `code_unique` · `code_not_blank` · FK ทั้งสอง |

ข้อสังเกต (ไม่ใช่บั๊ก): ไม่มี index `booking_activities_booking_idx` ตามที่ PYG-633 เสนอ แต่ `booking_activities_unique (booking_id, care_activity_id)` มี `booking_id` นำหน้า ค้นตาม booking ใช้ index นี้ได้อยู่แล้ว

## 4. วิธีรันซ้ำ

```bash
# 1) DB ทิ้งได้จาก schema.prisma (migration chain รันจากศูนย์ไม่ได้ — ดู memory/PYG-415)
docker exec pyg521-qa-db psql -U postgres -c "create database qa636"
DATABASE_URL=postgresql://x:x@localhost:5432/x npx prisma migrate diff --from-empty \
  --to-schema-datamodel prisma/schema.prisma --script > /tmp/qa-schema.sql
docker exec -i pyg521-qa-db psql -U postgres -d qa636 -v ON_ERROR_STOP=1 < /tmp/qa-schema.sql
# 2) รัน (spec ล้าง care_activities แล้วรัน migration ข้อมูล S15 เอง — รันซ้ำบน DB เดิมได้)
QA_DATABASE_URL=postgresql://postgres:qa@127.0.0.1:5436/qa636 npm run test:e2e -- --runInBand test/pyg636
```

| ตรวจ | ผล |
|---|---|
| DB ใหม่ / รันซ้ำบน DB เดิม | 38 passed / 38 passed · jest ออกเองไม่ค้าง |
| `npm run test:e2e` ไม่ตั้ง env | PYG-636 skip 38 |
| `CI=1` ไม่ตั้ง env | ล้มพร้อมข้อความ `QA_DATABASE_URL is not set in CI` |
| `QA_DATABASE_URL` ชี้ host อื่น / supabase | throw `must be a disposable Postgres on localhost` |
| `tsc -p tsconfig.json` · eslint ไฟล์ใหม่ | 0 · 0 |

หมายเหตุ harness: `PrismaService` สร้าง `pg` Pool เองแล้วส่งให้ adapter → `$disconnect()` ไม่ปิด pool และ jest ไม่ออก (ไม่กระทบ production) harness จึงแทนด้วย client ที่ adapter เป็นเจ้าของ pool แบบเดียวกับ `test/pyg609-assessment.e2e-spec.ts`
