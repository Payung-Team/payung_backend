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
 */
import { GraphQLError } from 'graphql';

export const CONSENT_ERROR = {
  /** ยังไม่ยินยอมข้อที่บังคับ ณ จุดนั้น → FE ชี้ไปที่ช่องที่ยังไม่ติ๊ก */
  REQUIRED: 'CONSENT_REQUIRED',
  /** เวอร์ชันนโยบายที่ส่งมาไม่ตรงกับที่บังคับใช้ → FE ให้รีเฟรชแล้วอ่านใหม่ */
  POLICY_VERSION_MISMATCH: 'CONSENT_POLICY_VERSION_MISMATCH',
  /** ชนิดความยินยอมที่ไม่รู้จัก หรือไม่ได้ขอ ณ จุดนั้น */
  TYPE_INVALID: 'CONSENT_TYPE_INVALID',
  /** ส่งคำตอบของข้อเดียวกันมาซ้ำในคำขอเดียว — ตีความไม่ได้ว่ายินยอมหรือไม่ */
  DUPLICATE_ANSWER: 'CONSENT_DUPLICATE_ANSWER',
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
