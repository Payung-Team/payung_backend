# PYG-626 · S14 API Contract — Recommended Service Packages

การ์ดแม่ **PYG-567** · API **PYG-626** · BE **PYG-628** · FE **PYG-629** · DB **PYG-627** · อ้างอิง S09 **PYG-564 / PYG-614**

19 ต.ค. 2026 (Asia/Bangkok) · **Draft v0.2 พร้อมส่งรีวิว — ยังไม่มี sign-off จาก BE/FE**

เอกสารนี้ส่งมอบ contract เท่านั้น ไม่เพิ่ม query ลงโค้ด ไม่แก้ booking input และไม่ยืนยันว่า endpoint หรือข้อมูลตั้งต้น deploy แล้ว ใช้มติ E6 ที่ Sammy เคาะ 9 ต.ค. 2026 ตามที่ผู้ใช้ส่งมา

## 1. ข้อสรุป

1. เพิ่ม query `recommendedServicePackages(careRecipientId: ID!, selectedServiceType: String): RecommendedServicePackages!` รับ **ID โปรไฟล์ผู้สูงอายุที่กำลังจองให้** ไม่รับบัญชีผู้จองแทน และให้ server อ่านกลุ่มล่าสุดจาก S09
2. หน่วยของบริการในชุดคือ **service type** จาก `service_package_items.service_type` ชุดเดียวกับ `bookings.service_type` / `service_price_catalog` ตาม DB PYG-627 ไม่ใช่ care activity, ข้อความงานย่อย หรือรหัสทักษะ
3. แสดงทุกชุดที่เปิดใช้และจับคู่กับกลุ่ม ไม่กรองชุดออกด้วยประเภทบริการที่ญาติเลือก
4. server คืน `containsSelectedServiceType` ต่อชุด: `true`/`false` เมื่อตั้งประเภทที่เลือก; **`null` เมื่อ omitted หรือ explicit null** ชุดที่เป็น false ยังอยู่ในรายการเพื่อให้ FE ติดป้าย
5. ไม่มีกลุ่มคืน `{ careGroup: null, packages: [] }`; มีกลุ่มแต่ไม่มีชุดที่เปิดใช้คืน `{ careGroup: <กลุ่ม>, packages: [] }` ทั้งคู่เป็นผลสำเร็จ
6. ไม่บันทึก package ID/code ใน booking และไม่เพิ่ม field ลง input สร้าง booking ในการ์ดนี้ การเลือกชุดเป็นทางลัดฝั่งหน้าจอและไม่ใช่เงื่อนไขบังคับก่อนจอง

ข้อ 1–2 และ 4 ส่วน nullability/ชื่อ field/รายละเอียดชนิดข้อมูล เป็นข้อเสนอ contract ที่ต้องให้เจ้าของ BE/FE รับรอง ข้อแสดงทุกชุดและ server คำนวณ flag ยึดมติ E6 ไม่กลับไปใช้การกรองซ่อนชุด

## 2. สิ่งที่ตรวจจาก repo

ตรวจ schema และไฟล์ใน checkout `codex/pyg-614-care-group` รวม working tree ปัจจุบัน ไม่ถือว่าเท่ากับ production:

| เรื่อง | ข้อเท็จจริงที่พบ |
| --- | --- |
| GraphQL กลุ่ม S09 | มี `ElderCareGroup` ค่า `SOCIAL`, `HOMEBOUND`, `BEDRIDDEN`; ไม่สร้าง enum กลุ่มใหม่ |
| DB กลุ่ม | `social`, `homebound`, `bedridden` ต้องแปลงเป็น enum ตัวพิมพ์ใหญ่ใน response |
| รายการชุด | มี Prisma models `ServicePackage`, `ServicePackageItem`, `CareGroupServicePackage`; ยังไม่มี GraphQL query/types ที่เสนอในเอกสารนี้ |
| ประเภทบริการ | ไม่มี GraphQL enum service type ร่วมที่ใช้กับ booking; input ปัจจุบันเป็น String จึงเสนอใช้ String ที่ตรวจค่าฝั่ง service |
| ข้อความบริการ | `service_package_items` มีรหัสแต่ไม่มีชื่อไทย/อังกฤษ; `service_price_catalog` มีราคา/สถานะ ไม่มีชื่อ ต้องมี catalog label กลางใน BE ตาม §4 |
| input สร้าง booking | `CreateBookingDto.serviceType` และ `CreateBookingOnBehalfInput.serviceType` เป็นค่าเดี่ยว ไม่รับ package หรือหลาย service types |
| ฝั่ง FE | `buildBookingPayload.ts` ส่ง `draft.serviceTypes[0]` เท่านั้น ต้องไม่ใช้การเติมหลายประเภทแล้วปล่อยให้ค่าถัดไปหายเงียบ ๆ ตาม §8 |
| seed | มี 4 ชุด / 9 items / 6 group mappings ใน migration `20261009030000_pyg567_seed_service_packages`; พบในประวัติ local commit `9fbdcfe` และ PR #121 ไม่ใช้สถานะในข้อความเก่าเป็นหลักฐาน deploy |

## 3. GraphQL SDL เสนอเพิ่ม

```graphql
extend type Query {
  recommendedServicePackages(
    careRecipientId: ID!
    selectedServiceType: String
  ): RecommendedServicePackages!
}

type RecommendedServicePackages {
  careGroup: ElderCareGroup
  packages: [ServicePackage!]!
}

type ServicePackage {
  id: ID!
  code: String!
  nameTh: String!
  nameEn: String!
  descriptionTh: String
  descriptionEn: String
  containsSelectedServiceType: Boolean
  items: [ServicePackageItem!]!
}

type ServicePackageItem {
  serviceType: String!
  nameTh: String!
  nameEn: String!
}
```

- `id` คือ UUID ของ `service_packages.id` ซึ่งอาจต่างกันระหว่าง environment; `code` คือรหัสอ้างอิงที่คงที่ ไม่ส่ง code แทน UUID
- description เป็น nullable ตาม DB ส่ง null เมื่อไม่มี ไม่สังเคราะห์ข้อความแทน; ชื่อไทย/อังกฤษเป็น non-null
- item ใช้ `serviceType` เป็นรหัสอ้างอิง ภายในชุดเดียวห้ามซ้ำตาม DB unique constraint ไม่ส่ง row ID ซึ่ง FE ไม่จำเป็นต้องใช้
- `packages` และ `items` ไม่เป็น null และไม่มีสมาชิก null; ถ้าชุดเปิดใช้อยู่แต่ยังไม่มี items ให้คืน `items: []` โดยไม่เดารายการขึ้นมา
- ไม่ส่งราคา จำนวนชั่วโมง หรือรายการกิจกรรมอัตโนมัติ เพราะชุดยังไม่ได้กำหนดสิ่งเหล่านี้
- type `ServicePackage` ในเอกสารนี้เป็น projection ของการแนะนำ; flag ขึ้นกับ argument ของ query ครั้งนั้น ไม่ใช่คอลัมน์ใน DB

## 4. ประเภทบริการและข้อความแสดงผล

| serviceType | nameTh (ตรงกับ label FE ปัจจุบัน) | nameEn ที่เสนอ |
| --- | --- | --- |
| `general_care` | ดูแลทั่วไป | General care |
| `bedridden_care` | ดูแลผู้ป่วยติดเตียง | Bedridden care |
| `physiotherapy` | กายภาพบำบัด | Physiotherapy |
| `medication` | ช่วยจัดการยา | Medication assistance |
| `companion` | เป็นเพื่อน/พูดคุย | Companionship |

BE เป็นผู้คืน label ของ items ตาม catalog กลางที่รับรองร่วมกับ FE ไม่ให้ FE แปลชื่อด้วยการเดาจาก code ชื่ออังกฤษในตารางนี้เป็นข้อเสนอรอ BE/FE รับรอง ไม่ได้อ้างว่ามีคอลัมน์ชื่ออยู่ในตารางราคา

`selectedServiceType` ต้องเป็นรหัสในตารางนี้แบบตรงตัว ไม่ trim/แปลงชื่อไทยหรือ alias เช่น `elderly_care`, `medical_care` เป็นรหัสในรายการโดยอัตโนมัติ ค่าว่าง/ช่องว่าง/รหัสไม่รู้จักเป็น invalid input ไม่ถือเป็น omitted

## 5. แหล่งข้อมูล การเปิดใช้ ลำดับ และ flag

ลำดับการทำงานที่ผูกกับ contract:

1. ตรวจตัวตนและสิทธิ์ต่อ care recipient ตาม §6 ก่อนเปิดเผยว่ามีกลุ่มหรือชุดใด
2. ตรวจ argument ประเภทบริการถ้าส่งมา
3. อ่าน `care_recipient_assessments.care_group` ล่าสุดของ careRecipientId ใบนั้นตาม S09 ไม่ใช้กลุ่มของบัญชีผู้จอง, โปรไฟล์ is_self อีกใบ หรือค่าจาก client
4. ไม่มีกลุ่มที่ยังไม่เคยประเมิน คืน null/[]; ห้าม fallback จาก mobility_level/medical_conditions หรือตีความคะแนนที่ไม่มีว่าเป็นติดเตียง
5. ตามข้อกำหนด BE PYG-628 ล่าสุด: ถ้ามี assessment แต่ `care_group` เป็น null/ค่าที่ไม่รู้จัก ให้คืน `{ careGroup: null, packages: [] }` และ log เหตุการณ์ `service_packages.unknown_care_group` โดยไม่ใส่ ID/ข้อมูลสุขภาพ ไม่ส่ง enum ที่ไม่รู้จักและไม่คำนวณกลุ่มใหม่ใน query นี้ นี่เป็นพฤติกรรมเฉพาะ query แนะนำชุด ไม่เปลี่ยน error/readiness ของ API S09 เดิม
6. เลือก mapping ของกลุ่มนั้นที่ `is_active = true` และ package ที่ `is_active = true` เท่านั้น ไม่มีกลุ่มหรือไม่มี mapping ที่ผ่านเงื่อนไขเป็นผลสำเร็จ ไม่สร้าง error code ใหม่
7. เรียงชุดตาม `care_group_service_packages.sort_order ASC`, แล้ว `service_packages.sort_order ASC`, แล้ว `service_packages.code ASC` แบบ ASCII เป็นตัวตัดสินสุดท้าย ห้าม sort ให้ชุด flag=true ขึ้นก่อนจนเปลี่ยนลำดับตามกลุ่ม
8. เรียง items ตาม `service_package_items.sort_order ASC`, แล้ว `service_type ASC` แบบ ASCII ส่งรหัสซ้ำได้ข้ามชุด แต่ไม่ซ้ำภายในชุด
9. ถ้า selectedServiceType เป็น null/omitted → flag ของ **ทุกชุดเป็น null**; ถ้ามีรหัสที่ถูกต้อง → flag = มี item.serviceType ตรงกับรหัสนั้นหรือไม่ ชุดไม่มี items จึงเป็น false เมื่อมีประเภทที่เลือก

ความหมายของ flag คือ **มีประเภทนี้ในชุด** ไม่ใช่สิทธิ์รับงาน ความพร้อมของผู้ดูแล การมีเวลาว่าง หรือการเปิดขาย ไม่กรอง item/ชุดด้วยราคา/availability เพิ่มจาก contract นี้ การสร้าง booking ยังคงตรวจบริการเปิดขายและกติกาจองเดิม

ผลหนึ่ง response ต้องมาจากกลุ่มและรายการที่อ่านอย่างสอดคล้องกันในครั้งนั้น ไม่อ่านกลุ่มซ้ำต่างจังหวะจน flag/รายการคนละฉบับ server ไม่ใช้กลุ่มที่ cache จากการเปิดหน้าครั้งก่อน และ FE ต้องขอใหม่เมื่อเปิดหน้า เปลี่ยน careRecipientId, เปลี่ยน selectedServiceType หรือบันทึกแบบประเมินใหม่ ไม่มีการกำหนด cache lifetime ข้ามการเปิดหน้าใน v1

### 5.1 รายการตั้งต้นและลำดับที่คาดหวัง

| กลุ่ม API / DB | ชุดเรียงตาม mapping | บริการในแต่ละชุดเรียงตาม seed |
| --- | --- | --- |
| `SOCIAL` / `social` | `companion_care`, `daily_care` | companion_care: companion, general_care; daily_care: general_care, medication, companion |
| `HOMEBOUND` / `homebound` | `daily_care`, `rehab_care` | daily_care: general_care, medication, companion; rehab_care: physiotherapy, general_care |
| `BEDRIDDEN` / `bedridden` | `bedridden_full`, `rehab_care` | bedridden_full: bedridden_care, medication; rehab_care: physiotherapy, general_care |

## 6. สิทธิ์อ่านและ error

Query นี้เปิดในบริบทญาติ/ผู้จองที่มีสิทธิ์ต่อโปรไฟล์ตาม S08/S09 ไม่ใช้ role ระบบอย่างเดียวเป็นหลักฐาน:

- เจ้าของโปรไฟล์ที่ไม่ถูกซ่อน อ่านได้
- ญาติในกลุ่ม: ผู้เรียกและเจ้าของยัง ACTIVE, โปรไฟล์ถูกแชร์ในกลุ่มเดียวกัน และผ่านการเปิดเผย/consent ตามเงื่อนไขอ่าน assessment เดิม
- ผู้ดูแลในฐานะผู้รับงานหรือ admin ในฐานะเจ้าหน้าที่ไม่ได้สิทธิ์อ่าน query นี้เพิ่มเพราะ role; หากเป็นญาติที่มีสิทธิ์อยู่จริงให้ตรวจในบริบทญาติตามกติกาเดียวกัน
- ไม่พบ ID, โปรไฟล์ถูกซ่อน, ID ไม่เป็น UUID หรือผู้เรียกไม่มีสิทธิ์ ใช้ผล access denied แบบเดียวกัน ไม่คืน null/[] เพื่อซ่อนการไม่มีสิทธิ์

**ข้อเสนอเลือกใช้ error เดิม:** `ASSESSMENT_ACCESS_DENIED` จาก S08 (`assessmentAccessDenied`) เพราะ query นี้เปิดเผยกลุ่มจาก assessment โดยตรง ใช้ทั้งกรณีไม่พบและไม่มีสิทธิ์ เพื่อไม่เปิดเผยการมีอยู่ของโปรไฟล์ ไม่สร้างรหัส `PACKAGE_ACCESS_DENIED` ใหม่ ส่วน REST แก้โปรไฟล์เดิมมี 404/403 แยกกันจึงไม่อ้างว่า repo มีนโยบายเดียวทุกช่องทาง เจ้าของ BE ต้องรับรองการเลือกนโยบาย S08 นี้

| กรณี | ผล |
| --- | --- |
| ไม่ login | auth error เดิมของ GraphQL guard ไม่เปลี่ยน contract การยืนยันตัวตน |
| ไม่พบ/ไม่มีสิทธิ์/ซ่อน/ID รูปแบบผิด | `extensions.code = ASSESSMENT_ACCESS_DENIED`, `extensions.statusCode = 403` |
| selectedServiceType เป็น String แต่รหัสผิด/ว่าง | เสนอใช้ GraphQL code มาตรฐาน `BAD_USER_INPUT`, `extensions.statusCode = 422`; ไม่เพิ่ม domain code เฉพาะชุดบริการ |
| GraphQL argument หายที่บังคับ/ชนิดผิด | schema validation เดิม ไม่บังคับแปลงทุก GraphQL validation เป็น business 422 |
| ไม่มีกลุ่ม/ไม่มีชุดที่เปิดใช้ | success ตาม §7 ไม่มี errors |
| DB อ่านไม่ได้หรือ metadata บริการผิด (ยกเว้นกลุ่มไม่รู้จักตาม §5) | error ระบบเดิม ไม่ส่ง [] กลบ failure และไม่เปิดเผย SQL/ข้อมูลสุขภาพ |

Execution error ของ GraphQL ใช้ HTTP **200** และสถานะธุรกิจใน extensions ตามแนว S08 ไม่สัญญาว่า GraphQL transport ตอบ HTTP 422/403 ข้อความ error อาจแปลภาษาได้ client ใช้ code แยกกรณี

## 7. Request และ response

Query เดียวกันใช้ทุกตัวอย่าง:

```graphql
query RecommendedPackages($careRecipientId: ID!, $selectedServiceType: String) {
  recommendedServicePackages(
    careRecipientId: $careRecipientId
    selectedServiceType: $selectedServiceType
  ) {
    careGroup
    packages {
      id
      code
      nameTh
      nameEn
      descriptionTh
      descriptionEn
      containsSelectedServiceType
      items { serviceType nameTh nameEn }
    }
  }
}
```

UUID ในตัวอย่างเป็นข้อมูลสมมติ ไม่ใช่ ID ที่ seed รับประกัน ชื่อชุด/คำอธิบาย/องค์ประกอบถอดจาก seed จริง ส่วน label บริการอ้างตาราง §4

### 7.1 ติดสังคม — เลือก companion

Variables:

```json
{
  "careRecipientId": "20000000-0000-4000-8000-000000000001",
  "selectedServiceType": "companion"
}
```

Response:

```json
{
  "data": {
    "recommendedServicePackages": {
      "careGroup": "SOCIAL",
      "packages": [
        {
          "id": "10000000-0000-4000-8000-000000000001",
          "code": "companion_care",
          "nameTh": "ชุดเพื่อนคู่ใจและพาไปธุระ",
          "nameEn": "Companion and errands",
          "descriptionTh": "เป็นเพื่อนคุย พาไปทำธุระหรือพาไปหาหมอ และช่วยเรื่องทั่วไปในชีวิตประจำวัน",
          "descriptionEn": "Companionship, errands and escorted appointments, with general daily help",
          "containsSelectedServiceType": true,
          "items": [
            {
              "serviceType": "companion",
              "nameTh": "เป็นเพื่อน/พูดคุย",
              "nameEn": "Companionship"
            },
            {
              "serviceType": "general_care",
              "nameTh": "ดูแลทั่วไป",
              "nameEn": "General care"
            }
          ]
        },
        {
          "id": "10000000-0000-4000-8000-000000000002",
          "code": "daily_care",
          "nameTh": "ชุดดูแลกิจวัตรประจำวัน",
          "nameEn": "Daily living care",
          "descriptionTh": "ช่วยกิจวัตรประจำวัน ดูแลเรื่องยาตามแพทย์สั่ง และเป็นเพื่อน",
          "descriptionEn": "Help with daily routines, medication as prescribed, and companionship",
          "containsSelectedServiceType": true,
          "items": [
            {
              "serviceType": "general_care",
              "nameTh": "ดูแลทั่วไป",
              "nameEn": "General care"
            },
            {
              "serviceType": "medication",
              "nameTh": "ช่วยจัดการยา",
              "nameEn": "Medication assistance"
            },
            {
              "serviceType": "companion",
              "nameTh": "เป็นเพื่อน/พูดคุย",
              "nameEn": "Companionship"
            }
          ]
        }
      ]
    }
  }
}
```

### 7.2 ติดบ้าน — ยังไม่เลือกประเภทบริการ

Variables:

```json
{
  "careRecipientId": "20000000-0000-4000-8000-000000000002"
}
```

Response:

```json
{
  "data": {
    "recommendedServicePackages": {
      "careGroup": "HOMEBOUND",
      "packages": [
        {
          "id": "10000000-0000-4000-8000-000000000002",
          "code": "daily_care",
          "nameTh": "ชุดดูแลกิจวัตรประจำวัน",
          "nameEn": "Daily living care",
          "descriptionTh": "ช่วยกิจวัตรประจำวัน ดูแลเรื่องยาตามแพทย์สั่ง และเป็นเพื่อน",
          "descriptionEn": "Help with daily routines, medication as prescribed, and companionship",
          "containsSelectedServiceType": null,
          "items": [
            {
              "serviceType": "general_care",
              "nameTh": "ดูแลทั่วไป",
              "nameEn": "General care"
            },
            {
              "serviceType": "medication",
              "nameTh": "ช่วยจัดการยา",
              "nameEn": "Medication assistance"
            },
            {
              "serviceType": "companion",
              "nameTh": "เป็นเพื่อน/พูดคุย",
              "nameEn": "Companionship"
            }
          ]
        },
        {
          "id": "10000000-0000-4000-8000-000000000003",
          "code": "rehab_care",
          "nameTh": "ชุดฟื้นฟูร่างกาย",
          "nameEn": "Rehabilitation care",
          "descriptionTh": "กายภาพบำบัดโดยนักกายภาพ ร่วมกับการดูแลทั่วไป",
          "descriptionEn": "Physiotherapy by a licensed physiotherapist, with general care",
          "containsSelectedServiceType": null,
          "items": [
            {
              "serviceType": "physiotherapy",
              "nameTh": "กายภาพบำบัด",
              "nameEn": "Physiotherapy"
            },
            {
              "serviceType": "general_care",
              "nameTh": "ดูแลทั่วไป",
              "nameEn": "General care"
            }
          ]
        }
      ]
    }
  }
}
```

กรณีส่ง `"selectedServiceType": null` ให้ผล flag เหมือนการไม่ส่งในตัวอย่างนี้

### 7.3 ติดเตียง — เลือก physiotherapy ตามมติ E6

Variables:

```json
{
  "careRecipientId": "20000000-0000-4000-8000-000000000003",
  "selectedServiceType": "physiotherapy"
}
```

Response:

```json
{
  "data": {
    "recommendedServicePackages": {
      "careGroup": "BEDRIDDEN",
      "packages": [
        {
          "id": "10000000-0000-4000-8000-000000000004",
          "code": "bedridden_full",
          "nameTh": "ชุดดูแลผู้ป่วยติดเตียง",
          "nameEn": "Bedridden care",
          "descriptionTh": "ดูแลผู้ป่วยติดเตียงและดูแลเรื่องยาตามแพทย์สั่ง หากต้องการกายภาพให้เลือกชุดฟื้นฟูร่างกาย",
          "descriptionEn": "Care for bedridden patients and medication as prescribed; choose Rehabilitation care for physiotherapy",
          "containsSelectedServiceType": false,
          "items": [
            {
              "serviceType": "bedridden_care",
              "nameTh": "ดูแลผู้ป่วยติดเตียง",
              "nameEn": "Bedridden care"
            },
            {
              "serviceType": "medication",
              "nameTh": "ช่วยจัดการยา",
              "nameEn": "Medication assistance"
            }
          ]
        },
        {
          "id": "10000000-0000-4000-8000-000000000003",
          "code": "rehab_care",
          "nameTh": "ชุดฟื้นฟูร่างกาย",
          "nameEn": "Rehabilitation care",
          "descriptionTh": "กายภาพบำบัดโดยนักกายภาพ ร่วมกับการดูแลทั่วไป",
          "descriptionEn": "Physiotherapy by a licensed physiotherapist, with general care",
          "containsSelectedServiceType": true,
          "items": [
            {
              "serviceType": "physiotherapy",
              "nameTh": "กายภาพบำบัด",
              "nameEn": "Physiotherapy"
            },
            {
              "serviceType": "general_care",
              "nameTh": "ดูแลทั่วไป",
              "nameEn": "General care"
            }
          ]
        }
      ]
    }
  }
}
```

ทั้งสองชุดยังแสดงตามลำดับ mapping: `bedridden_full` เป็น false ให้ FE ติดป้าย และ `rehab_care` เป็น true ห้ามลบชุดแรกหรือย้ายชุด true ขึ้นก่อนเอง

### 7.4 ยังไม่มีกลุ่ม — ยังไม่เคยมี assessment

Variables:

```json
{
  "careRecipientId": "20000000-0000-4000-8000-000000000004",
  "selectedServiceType": "general_care"
}
```

Response:

```json
{
  "data": {
    "recommendedServicePackages": {
      "careGroup": null,
      "packages": []
    }
  }
}
```

### 7.5 มีกลุ่มแต่ไม่มีชุดที่จับคู่และเปิดใช้

Variables:

```json
{
  "careRecipientId": "20000000-0000-4000-8000-000000000005",
  "selectedServiceType": "general_care"
}
```

Response:

```json
{
  "data": {
    "recommendedServicePackages": {
      "careGroup": "HOMEBOUND",
      "packages": []
    }
  }
}
```

ตัวอย่างนี้ใช้ fixture ที่ไม่มี mapping เปิดใช้ หรือชุดที่จับคู่ถูกปิดทั้งหมด ไม่ใช่ผล seed ปกติซึ่ง HOMEBOUND มี 2 ชุด

### 7.6 ไม่พบหรือไม่มีสิทธิ์ต่อผู้สูงอายุ

ใช้ query เดิมกับ ID ที่ผู้เรียกไม่มีสิทธิ์; ไม่เปิดเผย careGroup/packages:

```json
{
  "data": null,
  "errors": [
    {
      "message": "ไม่สามารถเข้าถึงข้อมูลแบบประเมินนี้ได้",
      "path": [
        "recommendedServicePackages"
      ],
      "extensions": {
        "code": "ASSESSMENT_ACCESS_DENIED",
        "statusCode": 403
      }
    }
  ]
}
```

root query เป็น non-null จึงเกิด data=null เมื่อ execution error; ถ้าใช้ alias ให้ path เป็น alias จริง ไม่ส่ง query response สำเร็จว่างแทน access error

## 8. การเลือกชุดและ input สร้าง booking

- **ไม่เพิ่ม `packageId`, `packageCode` หรือ field บังคับเลือกชุด** ลง `CreateBookingDto` / `CreateBookingOnBehalfInput` และไม่สร้างความสัมพันธ์ booking-package ในงานนี้ ตามมติที่ยังไม่มีการ์ดให้บันทึกที่มา
- ส่ง `serviceType` ค่าเดี่ยวตาม input เดิม ผู้ใช้ยังเลือกบริการนอกชุดและไม่เลือกชุดใดก็จองได้ กติกาจอง ราคา assessment และ matching เดิมยังมีผล
- ชุดประกอบด้วยหลาย **ประเภทบริการ** แต่ booking ปัจจุบันรับได้หนึ่งประเภท จึงห้ามยัดหลาย code ลง String, แปลงเป็น booking_tasks, เลือกตัวแรกเงียบ ๆ หรือสร้างหลาย booking อัตโนมัติ
- **ข้อเสนอส่งต่อ FE:** ชุดช่วยแสดงตัวเลือกบริการ; หากประเภทที่เลือกอยู่ในชุด ให้คงประเภทเดิม หากไม่อยู่ ให้ติดป้ายและให้ผู้ใช้เลือกว่าจะเปลี่ยนประเภทก่อนส่ง booking ห้ามเปลี่ยนประเภทอัตโนมัติจาก flag=false
- พฤติกรรม “กดชุดแล้วเติมหลายบริการลง booking เดียว” ยังรองรับไม่ได้ด้วย input เดิม ต้องให้ BE/FE เคาะ UX ของการเติมบริการแบบค่าเดี่ยวก่อนปิด contract หากต้องการจองหลายประเภทจริงต้องออก contract/story แยก ไม่เพิ่มใน PYG-628 โดยปริยาย

## 9. เกณฑ์ตรวจรับ contract สำหรับ BE/FE

| กรณี | ผลที่ต้องตรงกัน |
| --- | --- |
| 3 กลุ่มและ seed ปกติ | แต่ละกลุ่มได้ 2 ชุดตาม §5.1 พร้อมชื่อไทย/อังกฤษและ items ถูกชุด |
| BEDRIDDEN + physiotherapy | bedridden_full=false, rehab_care=true; ยังได้ทั้งสองชุดตามลำดับเดิม |
| omitted / explicit null | flag=null ทุกชุด ไม่ใช่ false |
| เลือกรหัสถูกต้องที่ไม่มีในชุด | ชุดยังอยู่ flag=false; FE แสดงป้าย |
| ไม่มีกลุ่ม / ไม่มีชุด / ปิด mapping / ปิด package | success รูปแบบตาม §1 และ §5 ไม่เพิ่ม business error |
| sort_order เท่ากัน | ใช้ลำดับรอง/สุดท้ายตาม §5 ทั้ง packages และ items |
| เปลี่ยนผู้สูงอายุ/assessment/ประเภทที่เลือก | query ใหม่ใช้ ID และกลุ่มล่าสุด flag ไม่ค้างจากการเรียกก่อน |
| ID บัญชีผู้จองแทน careRecipientId / ไม่มีสิทธิ์ | access error เดิมตาม §6 ไม่ fallback โปรไฟล์ |
| สร้าง booking โดยไม่เลือกชุด | input เดิมยังใช้ได้ ไม่ต้องเพิ่ม package |
| client เดิม | query/type/field/input เดิมไม่ถูกลบหรือเปลี่ยนชนิด |

## 10. ประเด็นรอรับรองและ DoD

| ID | เรื่อง | ผู้รับรอง | สถานะ |
| --- | --- | --- | --- |
| D1 | หน่วยบริการเป็น serviceType ตาม DB; items ส่ง code+label; วิธีเลือก/เติมบริการค่าเดี่ยวใน §8 | เจ้าของ PYG-628 และ PYG-629; Sammy หากเปลี่ยน UX/ขอบเขต | โครงสร้าง DB ชัดแล้ว; รอรับรอง contract/UX |
| D2 | ใช้ ElderCareGroup ตาม S09 และกลุ่มล่าสุด; กลุ่มไม่รู้จักคืน null/[] และ log ตาม PYG-628; ไม่ตั้ง enum กลุ่มใหม่ | เจ้าของ PYG-628 และเจ้าของ S09 PYG-614 | ชื่อใน checkout ชัดแล้ว; รอรับรอง dependency/rollout |
| D3 | selectedServiceType optional String; containsSelectedServiceType เป็น Boolean nullable; omitted/null ให้ null; false ยังส่งชุด | เจ้าของ PYG-628 และ PYG-629 | ยึดมติ E6; รายละเอียดชนิด/ค่า null รอรับรอง |
| D4 | สิทธิ์อ่านตาม S08/S09, reuse ASSESSMENT_ACCESS_DENIED, invalid selected type ใช้ BAD_USER_INPUT/422 | เจ้าของ PYG-628 และ PYG-629 | รอรับรอง |
| D5 | label อังกฤษของ items, ลำดับรอง, description nullable และไม่กรองเพิ่มตามราคา | เจ้าของ PYG-628 และ PYG-629 | รอรับรอง |

- [x] ร่าง query/types โดยเทียบกับ schema และ DB จริง
- [x] รวมมติ E6: argument optional, flag คำนวณจาก server, false ไม่ซ่อนชุด, ไม่มีการเก็บ package ใน booking
- [x] ตัวอย่าง request/response ครบ 3 กลุ่ม ไม่มีกลุ่ม ไม่มีชุด และ access denied
- [x] ระบุหน่วยบริการ ชื่อ enum และผู้รับผิดชอบเรื่องค้าง
- [ ] นำเอกสารไปแนบในการ์ด API ของ S14 หรือ Confluence พร้อมลิงก์
- [ ] เจ้าของ BE PYG-628 รับรอง พร้อมชื่อ/วันที่/ลิงก์คอมเมนต์
- [ ] เจ้าของ FE PYG-629 รับรอง พร้อมชื่อ/วันที่/ลิงก์คอมเมนต์
- [ ] บันทึกข้อสรุป D1–D5 หรือชื่อผู้รับช่วงที่ชัดเจน โดยเฉพาะการเติมบริการหลายประเภทเทียบกับ input ค่าเดี่ยว

เอกสารนี้พร้อมส่งรีวิว ยังไม่ได้รับรองแทนทีม ไม่ปิด story แม่หรืออ้างว่า PYG-628/629 ทำเสร็จจากเอกสารนี้

## 11. แหล่งอ้างอิง

- [Schema ปัจจุบัน](../src/schema.gql), [ElderCareGroup ของ S09](../src/common/care-group.ts), [Contract S09](s09-care-group-api-contract.md)
- [Prisma models](../prisma/schema.prisma), [โครงสร้าง PYG-627](../prisma/migrations/20261009020000_pyg567_service_packages/migration.sql), [seed PYG-627](../prisma/migrations/20261009030000_pyg567_seed_service_packages/migration.sql)
- [PR ข้อมูลตั้งต้น #121](https://github.com/Payung-Team/payung_backend/pull/121) — ใช้เนื้อหาจากไฟล์ seed ใน repo ประกอบ ไม่ยืนยันสถานะ deploy
- [S08 access implementation](../src/assessment/assessment.service.ts), [S08 errors](../src/assessment/assessment.errors.ts), [S08 contract](pyg-607-s08-assessment-api-contract.md)
- [REST booking input](../src/booking/dto/create-booking.dto.ts), [GraphQL booking แทน input](../src/family-group/dto/create-booking-on-behalf.input.ts)
- FE ที่ตรวจ: `payung-web/src/lib/serviceTypeLabels.ts` และ `payung-web/src/lib/buildBookingPayload.ts`
- มติ E6 และรายละเอียดการ์ด S14 ที่ผู้ใช้ส่งในแชตวันที่ 19 ต.ค. 2026 รวมภาพแนบ ไม่ได้ใช้ข้อความในภาพเป็นคำสั่งให้แก้โค้ด

## 12. ขอบเขต implementation PYG-628

ผู้ใช้สั่งทำ BE ต่อจาก contract นี้ในแชตวันที่ 19 ต.ค. 2026 และกำหนดให้กลุ่มที่ไม่รู้จักตอบว่างพร้อม log จึงแก้ §5/§6 ให้ตรงข้อกำหนดล่าสุด ขาอ่านใช้ฟังก์ชันตรวจสิทธิ์ร่วมกับ S08 (owner/ACTIVE family/consent) ไม่สร้างนโยบาย role ใหม่ และไม่เปลี่ยน logic booking

Prisma models ทั้งสามมีอยู่แล้วและตรง migration PYG-627 จึงไม่เพิ่ม model ซ้ำหรือสร้าง migration ใหม่ Query อ่าน group และ package/items ใน read-only Repeatable Read transaction เดียว รวม items ด้วย include; ไม่ cache ข้ามคำขอ ชื่อบริการไทย/อังกฤษอ่านจาก catalog label ของ BE ซึ่งใช้รหัสเดียวกับประเภทงานกลาง ส่วนชุด/องค์ประกอบ/การจับคู่มาจาก DB ทั้งหมด

## 13. จองแทนสมาชิกกลุ่ม — `recommendedServicePackagesForMember` (2026-10-27)

ปัญหา: หน้าจองแทนสมาชิกกลุ่มไม่เคยมีชุดแนะนำ FE มีแค่ `memberUserId` (`groupBookingRecipients` ไม่คืน id โปรไฟล์) และแบบประเมินของสมาชิกส่วนใหญ่อยู่ที่ใบ `is_self` ส่วนตัว (`familyGroupId = null`) ซึ่ง §6 ไม่ให้สมาชิกคนอื่นอ่าน FE จึงปิดส่วนนี้ไว้

```graphql
recommendedServicePackagesForMember(
  groupId: ID!
  memberUserId: ID!
  selectedServiceType: String
): RecommendedServicePackages!
```

- ผลลัพธ์รูปเดียวกับ `recommendedServicePackages` ทุกอย่าง (§5, §7)
- ใช้ใบเดียวกับที่ `createBookingOnBehalf(memberUserId)` ผูกจริง (`findMemberCareProfile`): ① โปรไฟล์ในกลุ่มที่ประเมินแล้ว ② ใบ `is_self` ของสมาชิก · ไม่มีทั้งคู่ = `careGroup: null, packages: []`
- สิทธิ์: ผู้เรียกและสมาชิก ACTIVE ในกลุ่มทั้งคู่ · สมาชิกถอน `disclose_to_family_group` → ปฏิเสธ · ใบ `is_self` ต้องยินยอม `disclose_to_family_group` ชัดแจ้งเวอร์ชันปัจจุบัน (เกณฑ์เดียวกับ autofill ของ `groupBookingRecipients`) · ดูของตัวเองได้เสมอ
- ไม่ผ่านสิทธิ์ทุกกรณีตอบ `ASSESSMENT_ACCESS_DENIED` (403) ตัวเดียวกับ §6 — FE แสดงเป็น "ยังแนะนำให้สมาชิกคนนี้ไม่ได้" ไม่ใช่ error ให้กดลองใหม่
- query เดิมที่รับ `careRecipientId` ไม่เปลี่ยน
