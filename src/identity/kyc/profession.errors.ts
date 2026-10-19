/**
 * Error ของเรื่องวิชาชีพผู้ดูแล (PYG-556 · contract PYG-573 §5)
 *
 * ★ ทำไมเป็น GraphQLError ไม่ใช่ BadRequestException / UnprocessableEntityException ของ Nest?
 *   @nestjs/apollo แปลง HttpException เป็น code ทั่วไปตาม status (422 → BAD_USER_INPUT, 409 → INTERNAL_SERVER_ERROR)
 *   code ที่ตกลงกับ FE จะหายไประหว่างทาง — GraphQLError + extensions คุม shape ได้ตรง ๆ
 *   แพตเทิร์นเดียวกับ ConsentError / FieldLockedError / FamilyGroupError ที่ใช้อยู่แล้วในโปรเจกต์
 *   ผลที่ FE เห็น: HTTP 200 + errors[0].extensions.code
 *
 * ⚠ ใช้กับ GraphQL เท่านั้น — ถ้าโยนใน REST controller Nest จะตอบ 500
 *
 * Contract กับ FE (ห้ามเปลี่ยนสตริงของ code โดยไม่บอกทีม FE):
 *   { code: 'PROFESSION_REQUIRED', allowed: [...] }
 *   { code: 'PROFESSION_INVALID', allowed: [...], received: 'xxx' }
 *   { code: 'PROFESSION_CHANGE_NOT_ALLOWED', kycStatus: 'pending' }
 *   { code: 'PROFESSION_UNCHANGED', profession: 'nurse' }
 *   { code: 'PROFESSION_CHANGE_ALREADY_PENDING', requestId: 'uuid' }
 *   { code: 'PROFESSION_CHANGE_NOT_FOUND' }
 *   { code: 'PROFESSION_CHANGE_NOT_PENDING', status: 'approved' }
 *   { code: 'PROFESSION_CHANGE_LICENSE_UNUSABLE', licenseStatus: 'rejected' | 'missing' }  (PYG-663 · แอดมินอนุมัติไม่ได้)
 */
import { GraphQLError } from 'graphql';
import {
  CAREGIVER_PROFESSIONS,
  CaregiverProfession,
  isCaregiverProfession,
} from './profession.constants';

export const PROFESSION_ERROR = {
  /** ไม่ส่งวิชาชีพ / ค่าว่าง — client เก่าที่ไม่รู้จัก field นี้จะเจอตัวนี้ (S01-E3) */
  REQUIRED: 'PROFESSION_REQUIRED',
  /** ค่านอก 3 ค่าที่กำหนด (S01-E4) */
  INVALID: 'PROFESSION_INVALID',
  /** ขอเปลี่ยนวิชาชีพตอน KYC ยังไม่อนุมัติ — ให้ใช้ฟอร์ม KYC แทน */
  CHANGE_NOT_ALLOWED: 'PROFESSION_CHANGE_NOT_ALLOWED',
  /** ขอเปลี่ยนเป็นค่าเดียวกับปัจจุบัน */
  UNCHANGED: 'PROFESSION_UNCHANGED',
  /** มีคำขอรอตรวจอยู่แล้ว (pending ได้ทีละ 1 คำขอ) */
  CHANGE_ALREADY_PENDING: 'PROFESSION_CHANGE_ALREADY_PENDING',
  /** ไม่พบคำขอ — หรือไม่ใช่ของผู้เรียก (ตอบเหมือนกันโดยตั้งใจ กันการเดา id ของคนอื่น) */
  CHANGE_NOT_FOUND: 'PROFESSION_CHANGE_NOT_FOUND',
  /** คำขอจบไปแล้ว (ยกเลิก / อนุมัติ / ปฏิเสธ) ทำซ้ำไม่ได้ */
  CHANGE_NOT_PENDING: 'PROFESSION_CHANGE_NOT_PENDING',
  /**
   * PYG-663: แอดมินอนุมัติคำขอที่ใบประกอบฯ ใช้ไม่ได้แล้ว (ถูกปฏิเสธ/หมดอายุ/หาย) หรือคำขอเก่าที่ไม่มีใบ
   * → ต้องปฏิเสธคำขอ ให้ผู้ดูแลยื่นใหม่พร้อมใบใหม่
   */
  CHANGE_LICENSE_UNUSABLE: 'PROFESSION_CHANGE_LICENSE_UNUSABLE',
} as const;

export type ProfessionErrorCode =
  (typeof PROFESSION_ERROR)[keyof typeof PROFESSION_ERROR];

/** ฐานร่วมของทุก error เรื่องวิชาชีพ — บังคับให้มี extensions.code เสมอ */
export class ProfessionError extends GraphQLError {
  constructor(
    message: string,
    public readonly code: ProfessionErrorCode,
    extra: Record<string, unknown> = {},
  ) {
    super(message, { extensions: { code, ...extra } });
  }
}

/**
 * parseProfessionInput — ด่านเดียวของการตรวจวิชาชีพขาเข้า (KYC + คำขอเปลี่ยน)
 *
 * ★ ทำไมตรวจที่นี่ ไม่ใช้ @IsIn ใน DTO?
 *   decorator ของ DTO ตอบ BAD_REQUEST ก่อนถึงโค้ดนี้ (บทเรียน PYG-415) → FE ไม่ได้ code ตาม contract
 *   DTO จึงเช็คแค่ "เป็นข้อความ" ส่วนกติกาจริงอยู่ที่ฟังก์ชันนี้ที่เดียว
 *
 * - ไม่ส่ง / null / "" / มีแต่ช่องว่าง → PROFESSION_REQUIRED (ไม่เติมค่าเริ่มต้นให้เงียบ ๆ)
 * - ค่าอื่นที่ไม่ตรง 3 ค่าเป๊ะ ๆ (รวม "NURSE" ตัวพิมพ์ใหญ่ / " nurse" มีช่องว่าง) → PROFESSION_INVALID
 *   ไม่ trim/แปลงตัวพิมพ์ให้ — ค่ามาจากตัวเลือกใน FE เสมอ ถ้าไม่ตรงแปลว่า client ผิด ควรรู้ตัว
 */
export function parseProfessionInput(
  value: string | null | undefined,
): CaregiverProfession {
  if (value == null || value.trim() === '') {
    throw new ProfessionError('กรุณาเลือกวิชาชีพ', PROFESSION_ERROR.REQUIRED, {
      allowed: CAREGIVER_PROFESSIONS,
    });
  }

  if (!isCaregiverProfession(value)) {
    throw new ProfessionError(
      'วิชาชีพไม่ถูกต้อง — เลือกได้เฉพาะ ผู้ดูแลทั่วไป พยาบาล หรือนักกายภาพบำบัด',
      PROFESSION_ERROR.INVALID,
      { allowed: CAREGIVER_PROFESSIONS, received: value },
    );
  }

  return value;
}
