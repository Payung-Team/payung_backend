/**
 * PhoneAuthGateway — "ประตู" ระหว่าง PhoneAuthService กับ Supabase Auth (PYG-603)
 *
 * ── ทำไมแยกเป็น interface ──────────────────────────────────────────────────
 *   การ์ดกำหนด: "การส่ง SMS แยกเป็นส่วนที่เปลี่ยนผู้ให้บริการได้ และมีตัวปลอมสำหรับ test"
 *   - เปลี่ยนผู้ให้บริการ SMS (Twilio / MessageBird / Vonage …) = ตั้งที่ Supabase Dashboard
 *     ไม่ต้องแก้โค้ด BE เลย เพราะ Supabase เป็นคนคุยกับผู้ให้บริการ SMS
 *   - ถ้าวันหนึ่งเลิกใช้ Supabase ยืนยันเบอร์ (สร้างรหัสเอง) → เขียน implementation ใหม่ของ class นี้
 *     PhoneAuthService ไม่ต้องแก้
 *   - unit test ใช้ตัวปลอม (FakePhoneAuthGateway ในไฟล์ spec) → ไม่ส่ง SMS จริง ไม่ต่อ Supabase
 *   - dev / QA ใช้ "Test Phone Numbers and OTPs" ของ Supabase (เบอร์ทดสอบรหัสตายตัว ไม่ส่ง SMS จริง)
 *
 * ── ทำไมเป็น abstract class ไม่ใช่ interface ────────────────────────────────
 *   interface ของ TypeScript หายไปตอน compile → ใช้เป็น injection token ของ Nest ไม่ได้
 *   abstract class อยู่ถึง runtime → `constructor(private gateway: PhoneAuthGateway)` ใช้ได้ตรง ๆ
 */

/** บัญชี Supabase ที่ผูกกับเบอร์หนึ่ง (จาก auth.users) พร้อมแถวของเราใน public.users ถ้ามี */
export interface PhoneAccount {
  /** auth.users.id */
  supabaseUid: string;
  /** auth.users.phone_confirmed_at มีค่า = เบอร์นี้ยืนยันแล้วกับบัญชีนี้ */
  phoneConfirmed: boolean;
  /** public.users.id — null = บัญชี Supabase ที่ยังไม่มีแถวในระบบเรา (สมัครค้างไว้ · E12) */
  userId: string | null;
}

/** session ของ Supabase ที่ได้หลังยืนยันรหัส / แลก refresh token */
export interface PhoneSession {
  supabaseUid: string;
  accessToken: string;
  refreshToken: string;
}

/** สถานะเบอร์ล็อกอินของผู้ใช้หนึ่งคน (ใช้คำนวณ User.phoneVerified) */
export interface LoginPhoneStatus {
  /** auth.users.phone — รูปแบบที่ Supabase เก็บ ("66812345678") หรือ null */
  phone: string | null;
  /** auth.users.phone_confirmed_at มีค่าหรือไม่ */
  confirmed: boolean;
}

/**
 * ประเภทความล้มเหลวจาก Supabase — แปลงจาก error code ของ Supabase ให้เหลือแค่สิ่งที่ service ต้องตัดสิน
 *
 * - otp_rejected    รหัสผิดหรือหมดอายุ (Supabase แยกไม่ได้ — ดู PhoneOtpTracker)
 * - rate_limited    Supabase จำกัดความถี่เอง (ซ้อนกับของเรา)
 * - sms_failed      ผู้ให้บริการ SMS ล้มเหลว / ยังไม่ได้เปิด phone provider
 * - phone_taken     เบอร์ผูกกับผู้ใช้ Supabase คนอื่นแล้ว (unique ของ auth.users.phone)
 * - no_account      ขอรหัสล็อกอินให้เบอร์ที่ไม่มีบัญชี (เกิดได้เฉพาะตอนแข่งกัน — เราเช็คก่อนแล้ว)
 * - session_invalid refresh token / access token ใช้ไม่ได้แล้ว
 * - phone_invalid   Supabase ไม่รับรูปแบบเบอร์ (ไม่ควรเกิด — เราตรวจก่อนแล้ว)
 * - unavailable     อื่น ๆ: เครือข่าย / หมดเวลา / Supabase ล่ม / error ที่ไม่รู้จัก
 */
export type PhoneGatewayFailure =
  | 'otp_rejected'
  | 'rate_limited'
  | 'sms_failed'
  | 'phone_taken'
  | 'no_account'
  | 'session_invalid'
  | 'phone_invalid'
  | 'unavailable';

export class PhoneGatewayError extends Error {
  constructor(
    public readonly kind: PhoneGatewayFailure,
    /** มีเมื่อ kind = rate_limited และ Supabase บอกเวลารอมา */
    public readonly retryAfterSeconds?: number,
    /** ข้อความดิบจาก Supabase — สำหรับ log เท่านั้น ห้ามส่งให้ client */
    public readonly detail?: string,
  ) {
    super(`phone gateway: ${kind}`);
  }
}

export abstract class PhoneAuthGateway {
  /**
   * หาบัญชี Supabase ที่ใช้เบอร์นี้ (auth.users.phone) — null = ไม่มีใครใช้
   * @param supabasePhone รูปที่ Supabase เก็บ "66812345678"
   */
  abstract findAccountByPhone(
    supabasePhone: string,
  ): Promise<PhoneAccount | null>;

  /** สถานะเบอร์ล็อกอินของผู้ใช้ (public.users.id) — null = ไม่พบผู้ใช้ */
  abstract loginPhoneStatus(userId: string): Promise<LoginPhoneStatus | null>;

  /**
   * ส่งรหัสสำหรับสมัคร/ล็อกอิน (Supabase signInWithOtp)
   * @param createUser true = สร้างผู้ใช้ Supabase ถ้ายังไม่มี (SIGNUP) · false = ต้องมีอยู่แล้ว (LOGIN)
   */
  abstract sendSmsOtp(e164: string, createUser: boolean): Promise<void>;

  /** ตรวจรหัสสมัคร/ล็อกอิน (verifyOtp type sms) → session */
  abstract verifySmsOtp(e164: string, code: string): Promise<PhoneSession>;

  /** ส่งรหัสสำหรับผูกเบอร์กับผู้ใช้ที่ถือ access token นี้ (PUT /auth/v1/user { phone }) */
  abstract sendPhoneChangeOtp(accessToken: string, e164: string): Promise<void>;

  /** ตรวจรหัสผูกเบอร์ (verifyOtp type phone_change) → ผู้ใช้ Supabase ที่เบอร์ถูกผูกให้ */
  abstract verifyPhoneChangeOtp(
    e164: string,
    code: string,
  ): Promise<{ supabaseUid: string }>;

  /** แลก refresh token เป็น session ใหม่ (ใช้ตอนสร้างบัญชีหลังยอมรับเงื่อนไข) */
  abstract refreshSession(refreshToken: string): Promise<PhoneSession>;
}
