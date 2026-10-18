/**
 * Error ของเรื่องระดับผู้ดูแล (PYG-557 · S02 · contract PYG-579 §5)
 *
 * ★ ทำไมเป็น GraphQLError ไม่ใช่ UnprocessableEntityException (422) ของ Nest?
 *   การ์ดเสนอ "422 ตามแนวที่ repo ใช้" แต่ฝั่ง GraphQL ของ repo นี้ไม่ได้ส่ง HTTP status ของ business error ออกไป
 *   @nestjs/apollo แปลง 422 เป็น code ทั่วไป `BAD_USER_INPUT` → code ที่ตกลงกับ FE หายระหว่างทาง
 *   FE แยกไม่ออกว่า "ยังไม่ได้เลือกระดับ" หรือ "ส่งค่าผิด"
 *   GraphQLError + extensions คุม shape ได้ตรง ๆ — แพตเทิร์นเดียวกับ ProfessionError (PYG-575),
 *   ConsentError, FieldLockedError, FamilyGroupError ที่ใช้อยู่แล้ว
 *   ผลที่ FE เห็น: HTTP 200 + errors[0].extensions.code
 *
 * ⚠ ใช้กับ GraphQL เท่านั้น — ถ้าโยนใน REST controller Nest จะตอบ 500
 *
 * Contract กับ FE (ห้ามเปลี่ยนสตริงของ code โดยไม่บอกทีม FE):
 *   { code: 'CARE_LEVEL_REQUIRED', allowed: ['BASIC', 'INTERMEDIATE', 'ADVANCED'] }
 *   { code: 'CARE_LEVEL_INVALID', allowed: [...], received: 'EXPERT' }
 *   { code: 'CARE_LEVEL_REASON_REQUIRED' }
 *   { code: 'CARE_LEVEL_KYC_NOT_VERIFIED', kycStatus: 'pending' }
 */
import { GraphQLError } from 'graphql';
import {
  CARE_LEVEL_INPUT_VALUES,
  CareLevel,
  careLevelFromInput,
} from './care-level';

export const CARE_LEVEL_ERROR = {
  /** อนุมัติ KYC โดยไม่มีระดับ (story R4 / E1) หรือส่งระดับว่างมาที่ setCaregiverCareLevel */
  REQUIRED: 'CARE_LEVEL_REQUIRED',
  /** ค่านอก 3 ค่า (story E9) */
  INVALID: 'CARE_LEVEL_INVALID',
  /** เปลี่ยนระดับหลังอนุมัติโดยไม่ใส่เหตุผล (มติ 2026-10-18: บังคับเหตุผลเมื่อเปลี่ยน) */
  REASON_REQUIRED: 'CARE_LEVEL_REASON_REQUIRED',
  /** ใช้ setCaregiverCareLevel กับผู้ดูแลที่ KYC ยังไม่อนุมัติ — ระดับแรกต้องเลือกตอนกดอนุมัติ (story R7) */
  KYC_NOT_VERIFIED: 'CARE_LEVEL_KYC_NOT_VERIFIED',
} as const;

export type CareLevelErrorCode =
  (typeof CARE_LEVEL_ERROR)[keyof typeof CARE_LEVEL_ERROR];

/** ความยาวสูงสุดของเหตุผล — DTO ตรวจด้วย @MaxLength ค่าเดียวกัน */
export const CARE_LEVEL_REASON_MAX_LENGTH = 500;

/** ฐานร่วมของทุก error เรื่องระดับ — บังคับให้มี extensions.code เสมอ */
export class CareLevelError extends GraphQLError {
  constructor(
    message: string,
    public readonly code: CareLevelErrorCode,
    extra: Record<string, unknown> = {},
  ) {
    super(message, { extensions: { code, ...extra } });
  }
}

/** E1 — ไม่มีระดับตอนอนุมัติ KYC (ทั้งไม่ได้ส่งมา และผู้ดูแลยังไม่เคยมีระดับ) */
export function careLevelRequiredError(): CareLevelError {
  return new CareLevelError(
    'กรุณาเลือกระดับผู้ดูแล (ต้น / กลาง / สูง) ก่อนอนุมัติ',
    CARE_LEVEL_ERROR.REQUIRED,
    { allowed: CARE_LEVEL_INPUT_VALUES },
  );
}

/** setCaregiverCareLevel กับผู้ดูแลที่ยังไม่ผ่าน KYC */
export function careLevelKycNotVerifiedError(
  kycStatus: string,
): CareLevelError {
  return new CareLevelError(
    'แก้ระดับได้เฉพาะผู้ดูแลที่อนุมัติ KYC แล้ว — ผู้ดูแลที่รอตรวจให้เลือกระดับตอนกดอนุมัติ',
    CARE_LEVEL_ERROR.KYC_NOT_VERIFIED,
    { kycStatus },
  );
}

/**
 * แปลงค่าที่ client ส่งแบบ "ไม่บังคับ" (ใช้กับ approveKyc)
 *
 * - ไม่ส่ง / null / "" / มีแต่ช่องว่าง → null (= ไม่ได้เลือก ให้ผู้เรียกตัดสินเองว่าจะใช้ระดับเดิมหรือ error)
 * - ค่านอก 3 ค่า → CARE_LEVEL_INVALID ทันที ก่อนแตะ DB (E9)
 *
 * ★ ทำไมตรวจที่นี่ ไม่ใช้ @IsIn ใน DTO หรือรับเป็น enum ตรง ๆ?
 *   - decorator ของ DTO ตอบ BAD_REQUEST ก่อนถึงโค้ดนี้ (บทเรียน PYG-415)
 *   - ถ้าชนิดขาเข้าเป็น enum, GraphQL ปฏิเสธค่าผิดเองด้วย GRAPHQL_VALIDATION_FAILED
 *   ทั้งสองทาง FE จะไม่ได้ code CARE_LEVEL_INVALID ตาม contract → ขาเข้าจึงเป็น String แล้วตรวจที่นี่ที่เดียว
 */
export function parseOptionalCareLevelInput(
  value: string | null | undefined,
): CareLevel | null {
  if (value == null || value.trim() === '') return null;

  const level = careLevelFromInput(value);
  if (!level) {
    throw new CareLevelError(
      'ระดับผู้ดูแลไม่ถูกต้อง',
      CARE_LEVEL_ERROR.INVALID,
      {
        allowed: CARE_LEVEL_INPUT_VALUES,
        received: value,
      },
    );
  }
  return level;
}

/**
 * แปลงค่าที่ client ส่งแบบ "บังคับ" (ใช้กับ setCaregiverCareLevel)
 * ไม่ส่ง / ค่าว่าง → CARE_LEVEL_REQUIRED · ค่านอกรายการ → CARE_LEVEL_INVALID
 */
export function parseCareLevelInput(
  value: string | null | undefined,
): CareLevel {
  const level = parseOptionalCareLevelInput(value);
  if (!level) {
    throw new CareLevelError(
      'กรุณาเลือกระดับผู้ดูแล',
      CARE_LEVEL_ERROR.REQUIRED,
      {
        allowed: CARE_LEVEL_INPUT_VALUES,
      },
    );
  }
  return level;
}

/**
 * ตรวจเหตุผลของการเปลี่ยนระดับ — คืนค่าที่ trim แล้ว
 * ไม่ส่ง / ว่าง / มีแต่ช่องว่าง → CARE_LEVEL_REASON_REQUIRED
 * (ความยาวเกิน CARE_LEVEL_REASON_MAX_LENGTH ถูก DTO กันไว้ก่อนแล้ว)
 */
export function parseCareLevelReason(value: string | null | undefined): string {
  const reason = value?.trim() ?? '';
  if (reason === '') {
    throw new CareLevelError(
      'กรุณาระบุเหตุผลของการเปลี่ยนระดับ',
      CARE_LEVEL_ERROR.REASON_REQUIRED,
    );
  }
  return reason;
}
