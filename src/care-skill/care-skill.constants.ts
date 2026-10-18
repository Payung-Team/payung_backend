/**
 * ทักษะผู้ดูแล — รหัสกลาง (care_skills) และการล็อกวิชาชีพ (PYG-652)
 *
 * ★ แหล่งเดียวของ "ทักษะไหนต้องเป็นวิชาชีพอะไร" ในโค้ด BE
 *   ใช้ทั้งตอนตรวจทักษะที่ผู้ดูแลบันทึก (CareSkillService.assertSkillsAllowed)
 *   และตอนคืนรายการทักษะให้หน้า KYC (careSkills query) — ห้ามก๊อปรายการนี้ไปไว้ที่อื่น
 *
 *   ที่อื่นที่ยังมีรายการเดียวกัน (แก้ไม่ได้ / ไม่ควรแก้):
 *   - migration 20261014000000_pyg652_caregiver_skills_to_central_codes (CTE profession_only)
 *     เป็นภาพ ณ วันที่แปลงข้อมูล — migration ที่รันแล้วห้ามแก้
 *   - care_activity_professions ล็อกวิชาชีพของ "กิจกรรม" (care_activities) ไม่ใช่ของทักษะ
 *
 * ทักษะที่ไม่อยู่ใน map นี้ = ทักษะพื้นฐาน ทุกวิชาชีพเลือกได้
 */

/** ค่าของ caregivers.profession — ตรงกับ CHECK caregivers_profession_check ใน DB */
export const PROFESSION = {
  GENERAL_CAREGIVER: 'general_caregiver',
  NURSE: 'nurse',
  PHYSIOTHERAPIST: 'physiotherapist',
} as const;

export type Profession = (typeof PROFESSION)[keyof typeof PROFESSION];

export const PROFESSIONS: readonly Profession[] = Object.values(PROFESSION);

/** ค่า default ของคอลัมน์ caregivers.profession — ใช้กับผู้ดูแลที่ยังไม่มีแถวตอนยื่น KYC ครั้งแรก */
export const DEFAULT_PROFESSION: Profession = PROFESSION.GENERAL_CAREGIVER;

/** รหัสทักษะ → วิชาชีพเดียวที่ถือทักษะนั้นได้ */
export const PROFESSION_LOCKED_SKILLS: Readonly<Record<string, Profession>> = {
  tube_feeding: PROFESSION.NURSE,
  injection: PROFESSION.NURSE,
  suction: PROFESSION.NURSE,
  tracheostomy_care: PROFESSION.NURSE,
  abdominal_wound_care: PROFESSION.NURSE,
  physiotherapy: PROFESSION.PHYSIOTHERAPIST,
};

/** วิชาชีพนี้ถือทักษะนี้ได้ไหม — ทักษะที่ไม่ล็อกได้ทุกวิชาชีพ */
export function isSkillAllowedForProfession(
  code: string,
  profession: string,
): boolean {
  const lockedTo = PROFESSION_LOCKED_SKILLS[code];
  return lockedTo === undefined || lockedTo === profession;
}

export function isProfession(value: string): value is Profession {
  return (PROFESSIONS as readonly string[]).includes(value);
}

/** ทักษะอื่น ๆ (ข้อความอิสระ) — จำนวนสูงสุดที่หน้าจอให้กรอก */
export const OTHER_SKILLS_MAX = 5;
/** ความยาวสูงสุดของทักษะอื่น ๆ แต่ละรายการ */
export const OTHER_SKILL_MAX_LENGTH = 100;

/**
 * ทำความสะอาดทักษะอื่น ๆ ก่อนตรวจ: ตัดช่องว่างหัวท้าย ทิ้งค่าว่าง และตัดค่าซ้ำ (เก็บตัวแรก)
 * ค่าที่ไม่ใช่ array หรือไม่ใช่ string ปล่อยผ่านให้ class-validator ปฏิเสธเอง
 */
export function normalizeOtherSkills(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  if (value.some((v) => typeof v !== 'string')) return value;
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of value as string[]) {
    const label = raw.trim();
    if (!label || seen.has(label)) continue;
    seen.add(label);
    result.push(label);
  }
  return result;
}
