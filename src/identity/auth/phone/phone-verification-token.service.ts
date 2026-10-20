/**
 * PhoneVerificationTokenService — ตั๋ว "ยืนยันเบอร์แล้ว รอสร้างบัญชี" (PYG-603 · contract PYG-601 §4.2)
 *
 * ── ทำไมต้องมีตั๋วนี้ ────────────────────────────────────────────────────────
 *   Flow สมัครตาม Design PYG-600: ยืนยันเบอร์ → เลือก role → อ่านและยอมรับเงื่อนไข → สร้างบัญชี
 *   - ถ้าให้ signUpWithPhone รับรหัส OTP ตอนท้าย: รหัสอายุ 60 วินาทีหมดระหว่างอ่านเงื่อนไขแน่นอน
 *   - ถ้าสร้างบัญชีตอนยืนยันรหัสเลย: ผิดกฎ PYG-474 "ไม่มี consent ครบ → ไม่สร้าง user"
 *   → ยืนยันรหัสก่อน แล้วออก "ตั๋ว" ให้ FE ถือไว้ระหว่างผู้ใช้อ่านเงื่อนไข (ข้อเสนอของ FE ใน PYG-601)
 *
 * ── ในตั๋วมีอะไร ─────────────────────────────────────────────────────────────
 *   { uid: ผู้ใช้ Supabase ที่ยืนยันเบอร์แล้ว, phone: E.164, rt: refresh token ของ Supabase, exp }
 *   - rt จำเป็น: ตอน signUpWithPhone ต้องออก session ให้ผู้ใช้ แต่ Supabase ไม่มี API ให้ server
 *     "สร้าง session ให้ผู้ใช้เบอร์โทร" เอง (generateLink ใช้ได้แค่อีเมล) → เก็บ refresh token จาก
 *     ตอนยืนยันรหัสไว้ในตั๋ว แล้วใช้แลก session ใหม่ตอนสร้างบัญชีเสร็จ
 *
 * ── ทำไมเข้ารหัส (AES-256-GCM) ไม่ใช่แค่เซ็น ────────────────────────────────
 *   refresh token เป็นกุญแจเข้าระบบ — ห้ามให้ client อ่านออก ไม่งั้นได้ session ก่อนยอมรับเงื่อนไข
 *   (ถึงจะใช้ทำอะไรไม่ได้เพราะยังไม่มีแถวใน public.users แต่ไม่ควรเปิดช่องไว้ตั้งแต่แรก)
 *   GCM = เข้ารหัส + กันแก้ไขในตัว: แก้ไบต์เดียวก็ถอดไม่ได้ ไม่ต้องมี HMAC แยก
 *   แพตเทิร์นเดียวกับ PayoutEncryptionService (PYG-266) — ใช้ crypto ของ Node ไม่เพิ่ม dependency
 *
 * ── กุญแจ ────────────────────────────────────────────────────────────────────
 *   PHONE_VERIFICATION_TOKEN_SECRET (≥ 32 ตัวอักษร) → SHA-256 → กุญแจ 32 ไบต์
 *   - dev/test ไม่ตั้ง: สุ่มให้ชั่วคราวต่อการรัน 1 ครั้ง + เตือน (แบบ QR_TOKEN_SECRET ของ PYG-434)
 *   - production ไม่ตั้ง: ★ ไม่ทำให้แอปบูตไม่ขึ้น (ต่างจาก QR) — แค่ verifyPhoneOtp/signUpWithPhone
 *     ใช้ไม่ได้และ log error ทุกครั้ง แบบ PayoutEncryptionService · ลืมตั้ง env ตัวเดียวไม่ควรทำให้
 *     ทั้งระบบล่ม (ล็อกอินด้วยอีเมล จอง จ่ายเงิน ต้องยังใช้ได้)
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'crypto';
import { phoneAuthUnavailableError } from './phone-auth.errors';

/** เนื้อหาในตั๋ว */
export interface PhoneVerificationClaims {
  /** id ของผู้ใช้ใน Supabase Auth (auth.users.id) ที่ยืนยันเบอร์ผ่านแล้ว */
  uid: string;
  /** เบอร์ที่ยืนยันแล้ว รูปแบบ E.164 */
  phone: string;
  /** refresh token ของ Supabase จากตอนยืนยันรหัส — ใช้แลก session ตอนสร้างบัญชี */
  rt: string;
}

export const PHONE_VERIFICATION_TOKEN_SECRET_ENV =
  'PHONE_VERIFICATION_TOKEN_SECRET';
export const PHONE_VERIFICATION_TOKEN_SECRET_MIN_LENGTH = 32;

/** หัวของตั๋ว — มีเลขเวอร์ชันเผื่อวันหนึ่งต้องเปลี่ยนรูปแบบ (ตั๋วเก่ายังแยกออกได้) */
const TOKEN_PREFIX = 'v1.';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
/**
 * AAD ผูกตั๋วไว้กับ "การใช้งานนี้" — ถ้าวันหนึ่งใช้กุญแจเดียวกันเข้ารหัสอย่างอื่น
 * ของอย่างอื่นจะเอามาใช้แทนตั๋วสมัครไม่ได้ (ถอดไม่ผ่านเพราะ AAD ไม่ตรง)
 */
const AAD = Buffer.from('payung:phone-signup-verification:v1', 'utf8');

@Injectable()
export class PhoneVerificationTokenService {
  private readonly logger = new Logger(PhoneVerificationTokenService.name);
  /** null = production ที่ไม่ได้ตั้งกุญแจ → ออก/อ่านตั๋วไม่ได้ */
  private readonly key: Buffer | null;

  constructor(config: ConfigService) {
    this.key = this.resolveKey(
      config.get<string>(PHONE_VERIFICATION_TOKEN_SECRET_ENV),
    );
  }

  /**
   * ออกตั๋ว
   * @param ttlSeconds อายุตั๋ว (PHONE_VERIFICATION_TOKEN_TTL_SECONDS)
   * @param now เวลาปัจจุบัน (ms) — รับจากผู้เรียกให้เทสคุมเวลาได้
   */
  seal(
    claims: PhoneVerificationClaims,
    ttlSeconds: number,
    now: number,
  ): string {
    const key = this.requireKey();
    const payload = JSON.stringify({
      ...claims,
      exp: Math.floor(now / 1000) + ttlSeconds,
    });
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, key, iv);
    cipher.setAAD(AAD);
    const ciphertext = Buffer.concat([
      cipher.update(payload, 'utf8'),
      cipher.final(),
    ]);
    // iv | tag | ciphertext ต่อกันเป็นก้อนเดียว แล้วเข้า base64url (ใส่ใน JSON/URL ได้ไม่ต้อง escape)
    const packed = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
    return TOKEN_PREFIX + packed.toString('base64url');
  }

  /**
   * อ่านตั๋ว — คืน null เมื่อใช้ไม่ได้ด้วยเหตุผลใดก็ตาม (ปลอม / ถูกแก้ / หมดอายุ / ผิดรูปแบบ)
   *
   * ★ ไม่แยกเหตุผล — ผู้ใช้ทำได้อย่างเดียวคือยืนยันเบอร์ใหม่ทุกกรณี (PHONE_VERIFICATION_EXPIRED)
   *   และการบอกว่า "ตั๋วนี้ปลอม" กับ "ตั๋วนี้หมดอายุ" ต่างกัน = ช่วยคนที่พยายามปลอมตั๋วฟรี ๆ
   */
  open(token: unknown, now: number): PhoneVerificationClaims | null {
    const key = this.requireKey();
    if (typeof token !== 'string' || !token.startsWith(TOKEN_PREFIX))
      return null;
    // ตั๋วจริงยาวไม่ถึง 2 KB (refresh token ของ Supabase สั้น) — ยาวผิดปกติไม่ต้องเสียเวลาถอด
    if (token.length > 4096) return null;

    const packed = Buffer.from(token.slice(TOKEN_PREFIX.length), 'base64url');
    if (packed.length <= IV_BYTES + TAG_BYTES) return null;

    try {
      const decipher = createDecipheriv(
        ALGORITHM,
        key,
        packed.subarray(0, IV_BYTES),
      );
      decipher.setAAD(AAD);
      decipher.setAuthTag(packed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
      const plaintext = Buffer.concat([
        decipher.update(packed.subarray(IV_BYTES + TAG_BYTES)),
        decipher.final(), // ★ throw ถ้าถูกแก้แม้แต่บิตเดียว (GCM auth tag ไม่ผ่าน)
      ]).toString('utf8');

      const data = JSON.parse(plaintext) as Record<string, unknown>;
      const { uid, phone, rt, exp } = data;
      if (
        typeof uid !== 'string' ||
        typeof phone !== 'string' ||
        typeof rt !== 'string' ||
        typeof exp !== 'number'
      ) {
        return null;
      }
      if (Math.floor(now / 1000) >= exp) return null; // หมดอายุ
      return { uid, phone, rt };
    } catch {
      return null;
    }
  }

  private requireKey(): Buffer {
    if (!this.key) {
      this.logger.error(
        `${PHONE_VERIFICATION_TOKEN_SECRET_ENV} ไม่ได้ตั้งค่าใน production — สมัครด้วยเบอร์โทรใช้ไม่ได้ (ดู .env.example)`,
      );
      throw phoneAuthUnavailableError();
    }
    return this.key;
  }

  private resolveKey(raw: string | undefined): Buffer | null {
    if (raw && raw.length >= PHONE_VERIFICATION_TOKEN_SECRET_MIN_LENGTH) {
      // SHA-256 แปลงข้อความยาวเท่าไหร่ก็ได้ให้เป็นกุญแจ 32 ไบต์พอดีที่ AES-256 ต้องการ
      return createHash('sha256').update(raw, 'utf8').digest();
    }

    const problem = raw
      ? `สั้นเกินไป (ต้องยาวอย่างน้อย ${PHONE_VERIFICATION_TOKEN_SECRET_MIN_LENGTH} ตัวอักษร)`
      : 'ไม่ได้ตั้งค่าไว้';

    if (process.env.NODE_ENV === 'production') {
      this.logger.error(
        `${PHONE_VERIFICATION_TOKEN_SECRET_ENV} ${problem} — การสมัครด้วยเบอร์โทรจะใช้ไม่ได้จนกว่าจะตั้งค่า`,
      );
      return null;
    }

    this.logger.warn(
      `${PHONE_VERIFICATION_TOKEN_SECRET_ENV} ${problem} → ใช้กุญแจสุ่มชั่วคราวสำหรับรอบนี้ ` +
        '(ตั๋วสมัครที่ออกไปแล้วจะใช้ไม่ได้หลัง restart) ตั้งค่าใน .env ก่อนใช้งานจริง',
    );
    return randomBytes(32);
  }
}
