/**
 * ค่าที่ตั้งได้ของ flow เบอร์โทร — PYG-603 (R8 ของ story PYG-562 · contract PYG-601 §7)
 *
 * ★ R8 "ตัวเลขยังไม่เคาะ" → ทุกค่าอ่านจาก env ไม่ฝังในโค้ด เปลี่ยนได้โดยไม่ต้อง deploy โค้ดใหม่
 *   ค่าเริ่มต้นเลือกให้ตรงกับค่าเริ่มต้นของ Supabase Auth และการ์ด (60 วินาที)
 *
 * ⚠ สองค่าต้อง "ตรงกับ Supabase Dashboard" (Auth → Providers → Phone):
 *   - PHONE_OTP_EXPIRES_SECONDS          = "SMS OTP Expiry"
 *     (BE ใช้แยก OTP_EXPIRED กับ OTP_INVALID เพราะ Supabase ตอบ otp_expired เหมือนกันทั้งสองกรณี
 *      ถ้าไม่ตรงกัน ผู้ใช้จะได้ข้อความผิดประเภท แต่ "ไม่" ทำให้รหัสที่ถูกใช้ไม่ได้)
 *   - PHONE_OTP_RESEND_COOLDOWN_SECONDS  ≥ ระยะห่างขั้นต่ำของ Supabase (ค่าเริ่มต้น 60 วินาที)
 *     (ถ้าน้อยกว่า ผู้ใช้จะกดขอใหม่ได้ตามตัวนับของเรา แล้วไปโดน Supabase ปฏิเสธเอง)
 */
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface PhoneAuthConfig {
  /** อายุรหัส OTP (วินาที) → `expiresInSeconds` ของ requestPhoneOtp */
  otpExpiresSeconds: number;
  /** ระยะห่างขั้นต่ำระหว่างการขอรหัสของเบอร์เดียวกัน (วินาที) → `resendAfterSeconds` */
  resendCooldownSeconds: number;
  /** กรอกผิดได้กี่ครั้งต่อรหัส 1 ชุด ก่อนรหัสนั้นใช้ไม่ได้ (E9) */
  maxAttempts: number;
  /** ส่ง SMS ไปเบอร์เดียวได้กี่ครั้งใน 24 ชม. (คุมค่า SMS ต่อเบอร์) */
  maxSendsPerPhonePerDay: number;
  /** ขอรหัสจาก IP เดียวได้กี่ครั้งใน 1 ชม. (กันยิงขอรหัสไปหลายเบอร์จนเปลืองค่า SMS) */
  maxSendsPerIpPerHour: number;
  /** อายุ verificationToken ของการสมัคร (วินาที) — เวลาให้ผู้ใช้อ่านและยอมรับเงื่อนไข */
  verificationTokenTtlSeconds: number;
}

/** ค่าเริ่มต้น — ใช้เมื่อไม่ได้ตั้ง env หรือค่าที่ตั้งไม่ถูกต้อง */
export const PHONE_AUTH_DEFAULTS: PhoneAuthConfig = {
  otpExpiresSeconds: 60, // = ค่าเริ่มต้น "SMS OTP Expiry" ของ Supabase
  resendCooldownSeconds: 60, // = การ์ดกำหนด 60 วินาที และ = max frequency เริ่มต้นของ Supabase
  maxAttempts: 5,
  maxSendsPerPhonePerDay: 10,
  maxSendsPerIpPerHour: 20,
  verificationTokenTtlSeconds: 30 * 60, // 30 นาที — พอให้เลื่อนอ่านข้อกำหนดและประกาศความเป็นส่วนตัวจนจบ
};

/** ชื่อ env ของแต่ละค่า — รวมไว้ที่เดียวให้ .env.example กับเอกสารอ้างตรงกัน */
export const PHONE_AUTH_ENV: Record<keyof PhoneAuthConfig, string> = {
  otpExpiresSeconds: 'PHONE_OTP_EXPIRES_SECONDS',
  resendCooldownSeconds: 'PHONE_OTP_RESEND_COOLDOWN_SECONDS',
  maxAttempts: 'PHONE_OTP_MAX_ATTEMPTS',
  maxSendsPerPhonePerDay: 'PHONE_OTP_MAX_SENDS_PER_PHONE_PER_DAY',
  maxSendsPerIpPerHour: 'PHONE_OTP_MAX_SENDS_PER_IP_PER_HOUR',
  verificationTokenTtlSeconds: 'PHONE_VERIFICATION_TOKEN_TTL_SECONDS',
};

/** injection token ของ PhoneAuthConfig (เป็น interface จึงใช้เป็น token เองไม่ได้) */
export const PHONE_AUTH_CONFIG = Symbol('PHONE_AUTH_CONFIG');

/**
 * อ่านค่าจาก env — ค่าที่ไม่ใช่จำนวนเต็มบวกใช้ค่าเริ่มต้นแทน (และเรียก onInvalid ให้เตือน)
 *
 * ★ ไม่ throw เมื่อค่าผิด — แอปทั้งตัวไม่ควรบูตไม่ขึ้นเพราะตั้งตัวเลขของฟีเจอร์เดียวผิด
 *   ใช้ค่าเริ่มต้นที่ปลอดภัยแทน แล้วเตือนใน log ให้คนตั้งค่ารู้ตัว
 */
export function loadPhoneAuthConfig(
  get: (key: string) => string | undefined,
  onInvalid: (key: string, value: string) => void = () => {},
): PhoneAuthConfig {
  const result = { ...PHONE_AUTH_DEFAULTS };
  for (const field of Object.keys(
    PHONE_AUTH_ENV,
  ) as (keyof PhoneAuthConfig)[]) {
    const key = PHONE_AUTH_ENV[field];
    const raw = get(key)?.trim();
    if (!raw) continue;
    const value = Number(raw);
    if (Number.isInteger(value) && value > 0) {
      result[field] = value;
    } else {
      onInvalid(key, raw);
    }
  }
  return result;
}

/** provider สำหรับ Nest — อ่านจาก ConfigService ครั้งเดียวตอนบูต */
export function phoneAuthConfigFactory(config: ConfigService): PhoneAuthConfig {
  return loadPhoneAuthConfig(
    (key) => config.get<string>(key),
    (key, value) =>
      new Logger('PhoneAuthConfig').warn(
        `${key}="${value}" ไม่ใช่จำนวนเต็มบวก → ใช้ค่าเริ่มต้นแทน`,
      ),
  );
}
