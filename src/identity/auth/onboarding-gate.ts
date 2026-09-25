/**
 * PYG-499 — ด่าน "ผู้สูงอายุที่ยังไม่ผ่าน Onboarding สร้าง Booking ไม่ได้"
 *
 * FE เด้งผู้ใช้ที่ยังไม่ onboard ไปหน้า Onboarding อยู่แล้ว (PYG-501) แต่นั่นกันได้แค่คนที่ใช้แอป
 * คนที่ยิง API ตรง ๆ ข้ามหน้าจอไปได้ → backend ต้องกันเองอีกชั้น (การ์ด PYG-496 ข้อ 8)
 *
 * ── เกณฑ์ ─────────────────────────────────────────────────────────────────
 *   บล็อกเมื่อ role = 1 (ผู้สูงอายุ) และยังไม่มี first_name / last_name
 *
 *   ★ ทำไมดูแค่ชื่อ-นามสกุล ไม่เรียก isOnboardingCompleted (UserService) ทั้งก้อน
 *     - users.first_name / last_name มีทางเขียนทางเดียวคือ completeOnboarding และเขียน
 *       "ในทรานแซคชันเดียวกับ" โปรไฟล์ is_self → มีชื่อ = เคยผ่าน Onboarding ครบแล้วจริง
 *     - isOnboardingCompleted ตรวจความยินยอมข้อมูลสุขภาพด้วย ถ้าใช้ตัวนั้น คนที่ "ถอนความยินยอม"
 *       จะได้ ONBOARDING_REQUIRED แทน CONSENT_WITHDRAWN (PYG-540) ซึ่งบอกทางแก้ผิดที่
 *       เรื่องความยินยอมมีด่านของมันเองอยู่แล้วใน BookingService — ไม่ต้องตรวจซ้ำที่นี่
 *     - เบากว่า: อ่านแถว users แถวเดียว ไม่ต้องไปอ่าน care_recipients / user_consents
 *
 *   ★ role อื่นผ่านเสมอ — ผู้ดูแล (role 2) จองแทนพ่อแม่ในกลุ่มครอบครัวได้ (PYG-412)
 *     และไม่มีหน้า Onboarding นี้ให้กรอก ถ้าบล็อกจะจองไม่ได้ตลอดกาล
 *
 * ── ทำไมมี error สองแบบ ─────────────────────────────────────────────────
 *   REST (POST /api/v1/bookings)  → onboardingRequiredHttpError() = ForbiddenException ที่มี statusCode
 *   GraphQL (createBookingOnBehalf) → OnboardingRequiredError = GraphQLError ที่มี extensions.code
 *   เหตุผลเดียวกับ consent.errors.ts: โยน GraphQLError ใน REST = 500
 *   และโยน ForbiddenException ใน GraphQL = code ของเราไปอยู่ใน originalError ไม่ใช่ extensions.code
 *
 * Contract กับ FE (ห้ามเปลี่ยนสตริงโดยไม่บอกทีม FE):
 *   { code: 'ONBOARDING_REQUIRED' }
 *   FE รอรับอยู่แล้วที่ payung_frontend/src/lib/bookingSubmitError.ts (BOOKING_ONBOARDING_REQUIRED_CODE)
 */
import { ForbiddenException } from '@nestjs/common';
import { GraphQLError } from 'graphql';
import { ROLE_ID } from '../../common/constants/roles.constant';

export const ONBOARDING_ERROR = {
  /** ผู้สูงอายุยังไม่ได้กรอกหน้า Onboarding → FE พาไปหน้า Onboarding */
  REQUIRED: 'ONBOARDING_REQUIRED',
} as const;

/** ข้อความที่ผู้ใช้เห็น — บอกทั้ง "ทำไม" และ "ต้องทำอะไรต่อ" */
export const ONBOARDING_REQUIRED_MESSAGE =
  'กรุณากรอกข้อมูลส่วนตัวในหน้าเริ่มต้นใช้งานให้เรียบร้อยก่อนจองผู้ดูแล';

/** คอลัมน์ขั้นต่ำที่ด่านนี้ต้องใช้ — ส่งเข้า prisma.user.findUnique({ select }) */
export const ONBOARDING_GATE_SELECT = {
  role: true,
  firstName: true,
  lastName: true,
} as const;

/** รูปทรงแถว users ที่ด่านนี้อ่าน (null = ไม่พบผู้ใช้) */
export type OnboardingGateAccount = {
  role: number;
  firstName: string | null;
  lastName: string | null;
} | null;

/**
 * ผู้ใช้คนนี้ต้องไปกรอก Onboarding ก่อนจองหรือไม่
 *
 * - ไม่พบผู้ใช้ → false (ไม่ใช่หน้าที่ของด่านนี้ — ไม่รู้ว่าเป็น role 1 หรือเปล่า
 *   และ auth guard ตรวจการมีอยู่ของบัญชีมาก่อนแล้ว)
 * - ★ ชื่อที่มีแต่ช่องว่างถือว่า "ไม่มี" — completeOnboarding trim ก่อนบันทึกอยู่แล้ว
 *   แต่ถ้าวันหนึ่งมีทางเขียนอื่นที่ไม่ trim ด่านนี้ต้องไม่ถูกหลอกด้วย ' '
 */
export function isOnboardingRequired(account: OnboardingGateAccount): boolean {
  if (!account || account.role !== ROLE_ID.PATIENT) return false;
  return !account.firstName?.trim() || !account.lastName?.trim();
}

/** สำหรับ **GraphQL** — extensions.code ตรง ๆ ให้ FE อ่านผ่าน extractGraphQLErrorCode */
export class OnboardingRequiredError extends GraphQLError {
  constructor() {
    super(ONBOARDING_REQUIRED_MESSAGE, {
      extensions: { code: ONBOARDING_ERROR.REQUIRED },
    });
  }
}

/**
 * สำหรับ **REST** — 403 + code ใน body
 *
 * ★ ต้องมี `statusCode` ใน body (แพตเทิร์นเดียวกับ consentWithdrawnHttpError)
 *   FE ตรวจ `code` ก่อน status อยู่แล้ว จึงแสดง message นี้แทนข้อความกลางของ 403
 */
export function onboardingRequiredHttpError(): ForbiddenException {
  return new ForbiddenException({
    statusCode: 403,
    error: 'Forbidden',
    code: ONBOARDING_ERROR.REQUIRED,
    message: ONBOARDING_REQUIRED_MESSAGE,
  });
}
