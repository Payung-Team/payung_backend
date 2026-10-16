/**
 * Error ของการบันทึกทักษะผู้ดูแล (PYG-652)
 *
 * ใช้ GraphQLError + extensions.code แพตเทิร์นเดียวกับ ConsentError / FamilyGroupError
 * (BadRequestException ของ Nest ทำ code หายระหว่างทาง — ดูเหตุผลใน consent.errors.ts)
 *
 * Contract กับ FE (ห้ามเปลี่ยนสตริงของ code โดยไม่บอกทีม FE):
 *   { code: 'SKILL_INVALID', skills: ['cooking'] }
 *     รหัสที่ไม่มีในรายการกลาง หรือถูกปิดใช้งานแล้ว
 *   { code: 'SKILL_NOT_ALLOWED_FOR_PROFESSION', skills: ['injection'], profession: 'general_caregiver' }
 *     ทักษะที่ล็อกให้วิชาชีพอื่น
 *   { code: 'PROFESSION_INVALID', profession: 'doctor' }
 *     careSkills(profession) ได้ค่าวิชาชีพที่ไม่รู้จัก
 */
import { GraphQLError } from 'graphql';

export const CARE_SKILL_ERROR = {
  SKILL_INVALID: 'SKILL_INVALID',
  SKILL_NOT_ALLOWED_FOR_PROFESSION: 'SKILL_NOT_ALLOWED_FOR_PROFESSION',
  PROFESSION_INVALID: 'PROFESSION_INVALID',
} as const;

export type CareSkillErrorCode =
  (typeof CARE_SKILL_ERROR)[keyof typeof CARE_SKILL_ERROR];

export class CareSkillError extends GraphQLError {
  constructor(
    message: string,
    public readonly code: CareSkillErrorCode,
    extra: Record<string, unknown> = {},
  ) {
    super(message, { extensions: { code, ...extra } });
  }
}
