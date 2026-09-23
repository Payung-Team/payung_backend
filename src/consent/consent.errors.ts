/**
 * Error ของเรื่องความยินยอม (PDPA) — PYG-474
 *
 * ★ ทำไมเป็น GraphQLError ไม่ใช่ BadRequestException / ForbiddenException ของ Nest?
 *   Nest แปลง exception เป็น GraphQL error ให้เฉพาะตัวที่ body มี `statusCode`
 *   (ดู createTransformHttpErrorFn ใน @nestjs/apollo) — แบบเดิมที่เขียนว่า
 *   `new ForbiddenException({ code: 'CONSENT_REQUIRED', ... })` ไม่มี statusCode
 *   → Apollo เลยตีเป็น `INTERNAL_SERVER_ERROR` และ **code ของเราหายไประหว่างทาง**
 *   FE (apolloErrors.ts → extractGraphQLErrorCode) อ่าน `extensions.code` เลยไม่มีทางรู้ว่า
 *   ติดเพราะยังไม่ยินยอม หรือเพราะนโยบายมีฉบับใหม่
 *
 *   GraphQLError + extensions คุม shape ได้ตรง ๆ — แพตเทิร์นเดียวกับ FieldLockedError
 *   และ FamilyGroupError ที่ใช้อยู่แล้วในโปรเจกต์
 *
 * ⚠ ใช้กับ GraphQL เท่านั้น — ถ้าโยนใน REST controller Nest จะตอบ 500
 *   (REST ต้องใช้ HttpException ที่มี statusCode แทน)
 *
 * Contract กับ FE (ห้ามเปลี่ยนสตริงของ code โดยไม่บอกทีม FE):
 *   { code: 'CONSENT_REQUIRED', consentType: 'terms_of_service' }
 *   { code: 'CONSENT_POLICY_VERSION_MISMATCH', currentVersion: '1.0' }
 *   { code: 'CONSENT_TYPE_INVALID', consentType: 'xxx' }
 *   { code: 'CONSENT_DUPLICATE_ANSWER', consentType: 'marketing' }
 *   { code: 'CONSENT_NOT_WITHDRAWABLE', consentType: 'terms_of_service' }      (PYG-540)
 *   { code: 'CONSENT_WITHDRAWN', consentType?: 'sensitive_health_data' }       (PYG-540)
 *     (consentType มีเฉพาะตอนเจ้าตัวจองเอง — จองแทนคนอื่นไม่บอกว่าเขาถอนข้อไหน)
 */
import { ForbiddenException } from '@nestjs/common';
import { GraphQLError } from 'graphql';
import { CONSENT_TYPE, DATA_CONTROLLER } from './consent.constants';

export const CONSENT_ERROR = {
  /** ยังไม่ยินยอมข้อที่บังคับ ณ จุดนั้น → FE ชี้ไปที่ช่องที่ยังไม่ติ๊ก */
  REQUIRED: 'CONSENT_REQUIRED',
  /** เวอร์ชันนโยบายที่ส่งมาไม่ตรงกับที่บังคับใช้ → FE ให้รีเฟรชแล้วอ่านใหม่ */
  POLICY_VERSION_MISMATCH: 'CONSENT_POLICY_VERSION_MISMATCH',
  /** ชนิดความยินยอมที่ไม่รู้จัก หรือไม่ได้ขอ ณ จุดนั้น */
  TYPE_INVALID: 'CONSENT_TYPE_INVALID',
  /** ส่งคำตอบของข้อเดียวกันมาซ้ำในคำขอเดียว — ตีความไม่ได้ว่ายินยอมหรือไม่ */
  DUPLICATE_ANSWER: 'CONSENT_DUPLICATE_ANSWER',
  /**
   * PYG-540 — ข้อนี้ถอนผ่านหน้าตั้งค่าไม่ได้ (ข้อกำหนดการใช้บริการ / ประกาศความเป็นส่วนตัว)
   * FE แสดงข้อความที่ BE ส่งมา ซึ่งบอกช่องทางขอลบบัญชีแทน
   */
  NOT_WITHDRAWABLE: 'CONSENT_NOT_WITHDRAWABLE',
  /**
   * PYG-540 — ทำรายการนี้ไม่ได้เพราะเจ้าของข้อมูลถอนความยินยอมไว้
   * (จองผู้ดูแลใหม่ / จองแทนในกลุ่มครอบครัว) · `consentType` บอกว่าข้อไหน
   */
  WITHDRAWN: 'CONSENT_WITHDRAWN',
} as const;

export type ConsentErrorCode =
  (typeof CONSENT_ERROR)[keyof typeof CONSENT_ERROR];

/** ฐานร่วมของทุก error เรื่อง consent — บังคับให้มี extensions.code เสมอ */
export class ConsentError extends GraphQLError {
  constructor(
    message: string,
    public readonly code: ConsentErrorCode,
    extra: Record<string, unknown> = {},
  ) {
    super(message, { extensions: { code, ...extra } });
  }
}

/**
 * ข้อความเมื่อจองไม่ได้เพราะถอนความยินยอม — PYG-540
 *
 * @param forSelf true = ผู้ใช้ถอนเอง (บอกว่าข้อไหน + ทางแก้ให้เขากลับไปให้ความยินยอม)
 *                false = จองแทนคนอื่นที่ถอนไว้ → ข้อความกลาง ๆ ไม่บอกว่าถอนข้อไหน
 *                ★ ว่าใครถอนความยินยอมเรื่องอะไรก็เป็นข้อมูลส่วนตัวของเขาเอง
 *                  คนกดจองรู้แค่ "จองแทนไม่ได้ ให้เจ้าตัวไปดู" ก็พอแก้ปัญหาได้แล้ว
 */
export function consentWithdrawnMessage(
  type: string,
  forSelf: boolean,
): string {
  if (!forSelf) {
    return (
      'ผู้รับบริการคนนี้ยังไม่ได้ให้ความยินยอมที่จำเป็นสำหรับการจองแทน จึงจองแทนไม่ได้ในตอนนี้ ' +
      'ให้เจ้าตัวตรวจสอบได้ที่หน้า "ความเป็นส่วนตัว" ของเขา'
    );
  }

  // ถอนข้อกลุ่มครอบครัว = จองผ่านกลุ่มไม่ได้ แต่ยังจองให้ตัวเองแบบปกติได้ (ไม่มีกลุ่มมาเกี่ยว)
  if (type === CONSENT_TYPE.DISCLOSE_TO_FAMILY_GROUP) {
    return (
      'คุณถอนความยินยอมเรื่องการเปิดเผยข้อมูลให้สมาชิกกลุ่มครอบครัวไว้ จึงจองผ่านกลุ่มไม่ได้ ' +
      'จองให้ตัวเองจากหน้าค้นหาผู้ดูแลได้ตามปกติ หรือให้ความยินยอมอีกครั้งได้ที่หน้า "ความเป็นส่วนตัว"'
    );
  }

  const subject =
    type === CONSENT_TYPE.SENSITIVE_HEALTH_DATA
      ? 'การเก็บข้อมูลสุขภาพ'
      : type === CONSENT_TYPE.DISCLOSE_TO_CAREGIVER
        ? 'การเปิดเผยข้อมูลสุขภาพแก่ผู้ดูแล'
        : 'ข้อที่จำเป็น';

  return (
    `คุณถอนความยินยอมเรื่อง${subject}ไว้ จึงจองผู้ดูแลใหม่ไม่ได้ ` +
    'หากต้องการจอง ให้ความยินยอมอีกครั้งได้ที่หน้า "ความเป็นส่วนตัว"'
  );
}

/**
 * ตัวเดียวกับ consentWithdrawnHttpError แต่สำหรับ **GraphQL** (จองแทนในกลุ่ม) — PYG-540
 *
 * ★ แนบ consentType เฉพาะกรณีเจ้าตัวเอง (forSelf) — จองแทนคนอื่นไม่บอกว่าเขาถอนข้อไหน
 */
export function consentWithdrawnError(
  type: string,
  forSelf: boolean,
): ConsentError {
  return new ConsentError(
    consentWithdrawnMessage(type, forSelf),
    CONSENT_ERROR.WITHDRAWN,
    forSelf ? { consentType: type } : {},
  );
}

/**
 * ตัวเดียวกับ ConsentError(WITHDRAWN) แต่สำหรับ **REST** (POST /api/v1/bookings) — PYG-540
 *
 * ★ ต้องมี `statusCode` ใน body — REST ของ Nest ส่ง body นี้กลับไปตรง ๆ ด้วย HTTP 403
 *   FE (bookingSubmitError.ts) อ่าน `code` จาก body เพื่อแยกจาก 403 "ไม่มีสิทธิ์" แบบอื่น
 *   (ห้ามโยน ConsentError ใน REST — GraphQLError ใน controller กลายเป็น 500)
 */
export function consentWithdrawnHttpError(
  type: string,
  forSelf: boolean,
): ForbiddenException {
  return new ForbiddenException({
    statusCode: 403,
    error: 'Forbidden',
    code: CONSENT_ERROR.WITHDRAWN,
    consentType: type,
    message: consentWithdrawnMessage(type, forSelf),
  });
}

/** ข้อความเมื่อพยายามถอนข้อที่ถอนผ่านหน้าตั้งค่าไม่ได้ — PYG-540 */
export const NOT_WITHDRAWABLE_MESSAGE =
  'ข้อนี้เป็นเงื่อนไขของการมีบัญชี จึงถอนแยกไม่ได้ ' +
  `หากไม่ต้องการใช้บริการต่อ ติดต่อขอลบบัญชีได้ที่ ${DATA_CONTROLLER.email}`;
