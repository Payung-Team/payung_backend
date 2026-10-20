/**
 * Error ของการสมัคร / ล็อกอิน / ผูกเบอร์ด้วยเบอร์โทร — PYG-603 (contract: PYG-601 §6)
 *
 * ★ ทำไมเป็น GraphQLError ไม่ใช่ UnprocessableEntityException (422) ตามที่การ์ดเสนอ?
 *   เหตุผลเดียวกับ ConsentError / FamilyGroupError: ถ้าโยน HttpException ของ Nest ใน GraphQL
 *   code ของเราจะไปอยู่ใน originalError แทน `extensions.code` → FE แยกกรณีไม่ได้
 *   (ดูคำอธิบายเต็มใน src/consent/consent.errors.ts)
 *   GraphQLError → Apollo ตอบ HTTP 200 + errors[0].extensions.code ซึ่ง FE อ่านได้ตรง ๆ
 *
 * ★ Contract กับ FE — ห้ามเปลี่ยนสตริงของ code โดยไม่บอกทีม FE
 *   FE map ไว้แล้วที่ payung_frontend/src/graphql/phoneAuth.ts (PHONE_AUTH_ERROR)
 *   และ src/lib/phoneAuthErrors.ts — ทุก code ด้านล่างตรงกับฝั่ง FE ทุกตัว
 *
 * ★ R10: message ห้ามมีรหัส OTP, verificationToken หรือเบอร์เต็ม
 *   message เป็นภาษาไทยที่บอกว่าผิดที่ไหนและต้องทำอะไรต่อ (R9) — FE ใช้ข้อความของตัวเองตาม code
 *   แต่ client อื่น (หรือคนที่ลองผ่าน GraphQL Playground) จะยังอ่านรู้เรื่อง
 */
import { GraphQLError } from 'graphql';

export const PHONE_AUTH_ERROR = {
  /** ไม่ใช่มือถือไทย 10 หลัก 06/08/09 — ตอบก่อนส่ง SMS เสมอ (R7) */
  PHONE_INVALID_FORMAT: 'PHONE_INVALID_FORMAT',
  /** เบอร์เป็นของบัญชีอื่นแล้ว (E4, E5) */
  PHONE_ALREADY_IN_USE: 'PHONE_ALREADY_IN_USE',
  /** ไม่มีบัญชีที่ใช้เบอร์นี้ล็อกอิน (E6 — บอกตรง ๆ ตาม Design PYG-600) */
  PHONE_NOT_REGISTERED: 'PHONE_NOT_REGISTERED',
  /** มีบัญชีที่กรอกเบอร์นี้ไว้ในโปรไฟล์ แต่ยังไม่เคยยืนยัน (E1) */
  PHONE_NOT_VERIFIED: 'PHONE_NOT_VERIFIED',
  /** รหัสผิด / เป็นรหัสเก่าก่อนขอใหม่ (E8) / ไม่มีรหัสค้างอยู่ */
  OTP_INVALID: 'OTP_INVALID',
  /** รหัสหมดอายุ (E7) */
  OTP_EXPIRED: 'OTP_EXPIRED',
  /** กรอกผิดครบจำนวนแล้ว รหัสนี้ใช้ไม่ได้อีกแม้กรอกถูก (E9) */
  OTP_ATTEMPTS_EXCEEDED: 'OTP_ATTEMPTS_EXCEEDED',
  /** ขอถี่เกิน (E10) — มี extensions.resendAfterSeconds */
  OTP_RATE_LIMITED: 'OTP_RATE_LIMITED',
  /** ผู้ให้บริการ SMS ล้มเหลว / หมดเวลา (E11) — ไม่นับเป็นการกรอกผิด */
  SMS_SEND_FAILED: 'SMS_SEND_FAILED',
  /** verificationToken ของการสมัครหมดอายุหรือใช้ไม่ได้ — ต้องยืนยันเบอร์ใหม่ */
  PHONE_VERIFICATION_EXPIRED: 'PHONE_VERIFICATION_EXPIRED',
} as const;

export type PhoneAuthErrorCode =
  (typeof PHONE_AUTH_ERROR)[keyof typeof PHONE_AUTH_ERROR];

/** ข้อความเริ่มต้นของแต่ละ code — บอก "ผิดที่ไหน" + "ต้องทำอะไรต่อ" (R9) */
const DEFAULT_MESSAGE: Record<PhoneAuthErrorCode, string> = {
  PHONE_INVALID_FORMAT:
    'เบอร์โทรศัพท์ไม่ถูกต้อง กรุณากรอกเบอร์มือถือ 10 หลักที่ขึ้นต้นด้วย 06, 08 หรือ 09',
  PHONE_ALREADY_IN_USE:
    'เบอร์นี้ใช้กับบัญชีอื่นแล้ว หากเป็นบัญชีของคุณ กรุณาเข้าสู่ระบบด้วยเบอร์นี้',
  PHONE_NOT_REGISTERED:
    'ไม่พบบัญชีที่ใช้เบอร์นี้เข้าสู่ระบบ กรุณาสมัครสมาชิกก่อน',
  PHONE_NOT_VERIFIED:
    'เบอร์นี้ยังไม่ได้ยืนยัน กรุณาเข้าสู่ระบบด้วยอีเมล แล้วยืนยันเบอร์ที่หน้าตั้งค่าเบอร์โทรศัพท์',
  OTP_INVALID: 'รหัสยืนยันไม่ถูกต้อง กรุณาตรวจสอบแล้วกรอกใหม่',
  OTP_EXPIRED: 'รหัสยืนยันหมดอายุแล้ว กรุณากดขอรหัสใหม่',
  OTP_ATTEMPTS_EXCEEDED:
    'กรอกรหัสผิดเกินจำนวนครั้งที่กำหนด รหัสนี้ใช้ไม่ได้แล้ว กรุณากดขอรหัสใหม่',
  OTP_RATE_LIMITED: 'ขอรหัสบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่',
  SMS_SEND_FAILED: 'ส่ง SMS ไม่สำเร็จ กรุณาลองใหม่อีกครั้งในภายหลัง',
  PHONE_VERIFICATION_EXPIRED:
    'การยืนยันเบอร์หมดอายุแล้ว กรุณายืนยันเบอร์โทรศัพท์อีกครั้ง',
};

/** ฐานของทุก error ใน flow เบอร์โทร — บังคับให้มี extensions.code เสมอ */
export class PhoneAuthError extends GraphQLError {
  constructor(
    public readonly code: PhoneAuthErrorCode,
    message: string = DEFAULT_MESSAGE[code],
    extra: Record<string, unknown> = {},
  ) {
    super(message, { extensions: { code, ...extra } });
  }
}

/**
 * OTP_RATE_LIMITED พร้อมเวลาที่ขอใหม่ได้ — FE ใช้ `extensions.resendAfterSeconds` แสดงตัวนับเวลา
 *
 * ★ ปัดขึ้นและอย่างน้อย 1 วินาทีเสมอ — FE ตีความ 0 / ค่าติดลบว่า "ไม่มีข้อมูลเวลา"
 *   (phoneAuthErrors.ts: `seconds > 0 ? seconds : undefined`) ถ้าส่ง 0 ตัวนับจะไม่ขึ้น
 */
export function otpRateLimitedError(waitSeconds: number): PhoneAuthError {
  const resendAfterSeconds = Math.max(1, Math.ceil(waitSeconds));
  return new PhoneAuthError(
    PHONE_AUTH_ERROR.OTP_RATE_LIMITED,
    `ขอรหัสบ่อยเกินไป กรุณารอ ${resendAfterSeconds} วินาทีแล้วลองใหม่`,
    { resendAfterSeconds },
  );
}

/**
 * ระบบยืนยันตัวตน (Supabase Auth) ขัดข้องระหว่างตรวจรหัส — ไม่ใช่ความผิดของผู้ใช้
 *
 * ใช้ code มาตรฐานของ Apollo (INTERNAL_SERVER_ERROR) ไม่ตั้ง code ใหม่ — FE แสดงข้อความกลาง
 * สำหรับ code ที่ไม่รู้จักอยู่แล้ว และ "ไม่นับเป็นการกรอกผิด" (ผู้เรียกคืนสิทธิ์การกรอกให้)
 */
export function phoneAuthUnavailableError(): GraphQLError {
  return new GraphQLError(
    'ระบบยืนยันตัวตนขัดข้องชั่วคราว กรุณาลองใหม่อีกครั้ง',
    { extensions: { code: 'INTERNAL_SERVER_ERROR' } },
  );
}
