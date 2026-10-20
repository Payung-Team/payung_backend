/**
 * ระดับผู้ดูแล / ระดับงาน — ต้น · กลาง · สูง (PYG-557 · S02 · contract PYG-579 §2)
 *
 * ★ ประกาศที่เดียวทั้ง BE — ระดับของ booking (S16 · PYG-569: bookings.required_level)
 *   และ care_activities.care_level (PYG-633) ใช้ค่าชุดเดียวกัน ที่ไหนต้องใช้ระดับให้ import จากไฟล์นี้
 *   อย่าประกาศ enum ระดับซ้ำในโมดูลอื่น ไม่งั้นวันหนึ่งสองชุดจะไม่ตรงกัน
 *
 * ── ค่า 2 ชั้น ─────────────────────────────────────────────────────────────
 *   GraphQL (ที่ FE เห็นและส่ง)   BASIC     INTERMEDIATE     ADVANCED
 *   DB (CHECK constraint)         'basic'   'intermediate'   'advanced'
 *
 *   TS enum ข้างล่างผูกสองชั้นนี้ไว้ด้วยกัน: ชื่อ key = ค่าใน GraphQL, value = ค่าใน DB
 *   NestJS แปลงให้เองตอนส่งออก — resolver คืน 'basic' → client เห็น "BASIC"
 *   (ค่าใน DB ถูกกันด้วย CHECK caregivers_care_level_check จาก PYG-580 อีกชั้น)
 */
import { registerEnumType } from '@nestjs/graphql';

export enum CareLevel {
  BASIC = 'basic',
  INTERMEDIATE = 'intermediate',
  ADVANCED = 'advanced',
}

// registerEnumType = บอก GraphQL ให้รู้จัก enum นี้ในชื่อ "CareLevel"
// (ไม่ register → ใช้เป็นชนิดของ @Field ไม่ได้)
registerEnumType(CareLevel, {
  name: 'CareLevel',
  description:
    'Caregiver / job level, lowest to highest: BASIC (ต้น) < INTERMEDIATE (กลาง) < ADVANCED (สูง)',
  valuesMap: {
    BASIC: { description: 'ต้น (basic)' },
    INTERMEDIATE: { description: 'กลาง (intermediate)' },
    ADVANCED: { description: 'สูง (advanced)' },
  },
});

/**
 * ทุกระดับ เรียงจากต่ำไปสูง (story R1)
 * ★ ลำดับใน array นี้คือความหมาย ห้ามสลับ — matching ของ S18 จะเทียบ "ระดับผู้ดูแล >= ระดับ booking" ด้วยลำดับนี้
 */
export const CARE_LEVELS: readonly CareLevel[] = [
  CareLevel.BASIC,
  CareLevel.INTERMEDIATE,
  CareLevel.ADVANCED,
];

/**
 * ค่าที่ client ส่งเข้ามาได้ = ชื่อ enum ใน GraphQL (ตัวพิมพ์ใหญ่ตรงตัว)
 * ใช้ทั้งตอนแปลงค่าขาเข้า และตอบใน extensions.allowed ของ error
 */
const INPUT_TO_LEVEL: Readonly<Record<string, CareLevel>> = {
  BASIC: CareLevel.BASIC,
  INTERMEDIATE: CareLevel.INTERMEDIATE,
  ADVANCED: CareLevel.ADVANCED,
};

export const CARE_LEVEL_INPUT_VALUES: readonly string[] =
  Object.keys(INPUT_TO_LEVEL);

/**
 * แปลงค่าที่ client ส่ง ("BASIC") → CareLevel ('basic')
 * ไม่ trim / ไม่แปลงตัวพิมพ์ให้ — ค่ามาจากตัวเลือกใน FE เสมอ ถ้าไม่ตรงแปลว่า client ผิด ควรรู้ตัว
 * (แนวเดียวกับ parseProfessionInput ของ PYG-575)
 *
 * @returns null เมื่อไม่ใช่ 1 ใน 3 ค่า
 */
export function careLevelFromInput(value: string): CareLevel | null {
  // hasOwnProperty กันค่าอย่าง "toString" / "__proto__" ที่ไปเจอ property ของ Object.prototype
  return Object.prototype.hasOwnProperty.call(INPUT_TO_LEVEL, value)
    ? INPUT_TO_LEVEL[value]
    : null;
}

/**
 * แปลงค่าจาก DB ('basic' | null) → CareLevel | null
 *
 * DB มี CHECK กันค่าแปลกอยู่แล้ว ฟังก์ชันนี้คือกันอีกชั้น: ถ้าวันหนึ่งมีค่านอกรายการหลุดเข้ามา
 * คืน null แทนที่จะส่งค่าที่ GraphQL serialize ไม่ได้ (ซึ่งจะทำให้ทั้ง query พัง)
 */
export function careLevelFromDb(
  value: string | null | undefined,
): CareLevel | null {
  if (value == null) return null;
  return (CARE_LEVELS as readonly string[]).includes(value)
    ? (value as CareLevel)
    : null;
}
