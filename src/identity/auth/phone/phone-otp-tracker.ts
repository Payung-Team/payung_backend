/**
 * PhoneOtpTracker — ตัวคุมจังหวะการขอรหัสและนับครั้งที่กรอกผิด (PYG-603 · R8, E7–E11)
 *
 * ── ทำไมต้องนับเอง ทั้งที่ Supabase สร้างและตรวจรหัสให้แล้ว ───────────────────
 *   1. Supabase ตอบ `otp_expired` เหมือนกันทั้ง "รหัสผิด" และ "รหัสหมดอายุ"
 *      → ต้องจำเวลาที่ส่งรหัสไว้เอง ถึงจะบอกผู้ใช้ได้ว่า OTP_INVALID หรือ OTP_EXPIRED (S07-AC7)
 *   2. Supabase ไม่จำกัดจำนวนครั้งที่กรอกผิดต่อรหัส 1 ชุด (มีแค่ rate limit ต่อ IP)
 *      → E9 "กรอกผิดเกินกำหนด รหัสนั้นใช้ไม่ได้อีกแม้กรอกถูก" ต้องบังคับที่ชั้นนี้
 *   3. คุมค่า SMS: ระยะห่างต่อเบอร์ + เพดานต่อเบอร์ต่อวัน + เพดานต่อ IP (E10 + ข้อเสนอในการ์ด)
 *   4. กันกดซ้ำพร้อมกัน — FE กันแล้ว แต่ BE ไม่พึ่ง FE (แต่ละครั้งเสียค่า SMS)
 *
 * ── "ช่อง" ของรหัส (channel) ─────────────────────────────────────────────────
 *   SIGNUP กับ LOGIN ใช้รหัสชนิดเดียวกันของ Supabase (`type: 'sms'`) บนผู้ใช้ Supabase คนเดียวกัน
 *   ส่วน LINK ใช้ `type: 'phone_change'` → นับครั้งที่ผิดแยกตาม channel ไม่ใช่ตาม purpose
 *   ★ ถ้านับตาม purpose คนที่เดารหัสจะได้ 5 ครั้งทาง verifyPhoneOtp + อีก 5 ครั้งทาง loginWithPhone
 *     กับรหัสชุดเดียวกัน = เดาได้สองเท่าของที่ตั้งใจ
 *
 * ⚠ ข้อจำกัด — ทั้งหมดอยู่ในหน่วยความจำของ process เดียว (แบบเดียวกับ SlidingWindowRateLimiter ของ PYG-479)
 *   - restart = นับใหม่ (ผลเสียมีแค่: ผู้ใช้ที่รอรหัสอยู่จะได้ OTP_INVALID แทน OTP_EXPIRED และได้นับครั้งใหม่)
 *   - รันหลาย instance เมื่อไหร่ ต้องย้ายไป Redis
 *   - Supabase มี rate limit ของตัวเองซ้อนอีกชั้น (Dashboard → Auth → Rate Limits) จึงไม่ได้พึ่งชั้นนี้ชั้นเดียว
 *
 * คลาสนี้ไม่แตะ Supabase / ดีบีเลย รับ `now` จากผู้เรียก → เทสเวลาได้โดยไม่ต้อง mock นาฬิกา
 */
import {
  DEFAULT_MAX_KEYS,
  SlidingWindowRateLimiter,
} from '../../../common/rate-limit/sliding-window-rate-limiter';
import type { PhoneAuthConfig } from './phone-auth.config';

/** ชนิดรหัสของ Supabase — SIGNUP/LOGIN = 'sms', LINK = 'phone_change' */
export type OtpChannel = 'sms' | 'phone_change';

/** ผลของการกรอกรหัสที่ Supabase ปฏิเสธ — ผู้เรียกแปลงเป็น error code */
export type OtpRejection = 'invalid' | 'expired' | 'exceeded';

/** สถานะของรหัสชุดล่าสุดของ (channel, เบอร์) หนึ่งคู่ */
interface OtpRecord {
  /** เวลาที่รหัสหมดอายุ (ms) — null = ไม่รู้ (ไม่ได้ส่งผ่าน instance นี้ / restart มา) */
  expiresAt: number | null;
  /** จำนวนครั้งที่กรอกไปแล้วกับรหัสชุดนี้ (รวมครั้งที่กำลังตรวจอยู่) */
  attempts: number;
  /** เวลาที่แตะ record นี้ล่าสุด — ใช้กวาด record เก่าทิ้ง */
  touchedAt: number;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * ★ ไม่ใช่ @Injectable — AuthModule สร้างผ่าน useFactory (ดู phoneOtpTrackerProvider)
 *   เพราะ maxKeys เป็นตัวเลขธรรมดา Nest inject ให้เองไม่ได้ และต้องเป็นตัวเดียวทั้งแอป (singleton)
 *   ไม่งั้นแต่ละที่จะนับแยกกัน = การจำกัดไม่มีผล
 */
export class PhoneOtpTracker {
  /** ระยะห่างขั้นต่ำระหว่างการส่งรหัสของเบอร์เดียวกัน (limit 1 ครั้งต่อ cooldown) */
  private readonly perPhoneCooldown: SlidingWindowRateLimiter;
  /** เพดานการส่งต่อเบอร์ใน 24 ชม. */
  private readonly perPhoneDaily: SlidingWindowRateLimiter;
  /** เพดานการขอรหัสต่อ IP ใน 1 ชม. */
  private readonly perIp: SlidingWindowRateLimiter;

  /** เบอร์ที่กำลังส่งรหัสอยู่ (ยังไม่ได้คำตอบจาก Supabase) — กันคำขอซ้ำพร้อมกัน */
  private readonly inFlight = new Set<string>();

  /** `${channel}:${เบอร์}` → สถานะรหัสชุดล่าสุด */
  private readonly otps = new Map<string, OtpRecord>();
  private lastSweepAt = 0;

  constructor(
    private readonly config: PhoneAuthConfig,
    private readonly maxKeys: number = DEFAULT_MAX_KEYS,
  ) {
    this.perPhoneCooldown = new SlidingWindowRateLimiter({
      limit: 1,
      windowMs: config.resendCooldownSeconds * 1000,
      maxKeys,
    });
    this.perPhoneDaily = new SlidingWindowRateLimiter({
      limit: config.maxSendsPerPhonePerDay,
      windowMs: DAY_MS,
      maxKeys,
    });
    this.perIp = new SlidingWindowRateLimiter({
      limit: config.maxSendsPerIpPerHour,
      windowMs: HOUR_MS,
      maxKeys,
    });
  }

  // ─── การส่งรหัส ──────────────────────────────────────────────────────────

  /**
   * ต้องรออีกกี่วินาทีก่อนส่งรหัสไปเบอร์นี้ได้ — 0 = ส่งได้เลย
   *
   * ★ เช็คอย่างเดียว ยังไม่นับ — นับเฉพาะตอน Supabase ส่ง SMS สำเร็จ (recordSent)
   *   คำขอที่ถูกปฏิเสธจึงไม่ยืดเวลารอ (แบบเดียวกับ JoinLinkRateLimitGuard ของ PYG-479)
   * @param phoneKey เบอร์รูปแบบเดียวเสมอ (ผู้เรียกใช้ e164)
   * @param ip null = หา IP ไม่ได้ → ข้ามการนับต่อ IP แต่ยังนับต่อเบอร์
   */
  sendWaitSeconds(phoneKey: string, ip: string | null, now: number): number {
    const waitMs = Math.max(
      this.perPhoneCooldown.retryAfterMs(phoneKey, now),
      this.perPhoneDaily.retryAfterMs(phoneKey, now),
      ip ? this.perIp.retryAfterMs(ip, now) : 0,
    );
    // ปัดขึ้น — ปัดลงแล้วได้ 0 จะบอกว่า "ขอได้เลย" ทั้งที่ยังไม่ได้
    return waitMs > 0 ? Math.ceil(waitMs / 1000) : 0;
  }

  /**
   * จองสิทธิ์ส่งรหัสให้เบอร์นี้ — false = มีคำขอของเบอร์นี้กำลังส่งอยู่ (กดซ้ำเร็ว ๆ)
   *
   * ★ จำเป็นเพราะระหว่าง sendWaitSeconds() กับ recordSent() มี await (รอ Supabase ส่ง SMS)
   *   คำขอที่สองที่มาระหว่างนั้นจะผ่านการเช็คเวลาได้ทั้งคู่ → SMS ออกสองข้อความ
   *   ต้องเรียก endSend() ใน finally เสมอ
   */
  tryBeginSend(phoneKey: string): boolean {
    if (this.inFlight.has(phoneKey)) return false;
    this.inFlight.add(phoneKey);
    return true;
  }

  /** ปลดสิทธิ์ที่จองไว้ด้วย tryBeginSend — เรียกใน finally */
  endSend(phoneKey: string): void {
    this.inFlight.delete(phoneKey);
  }

  /**
   * Supabase ส่ง SMS สำเร็จ → นับโควตา และเริ่มนับครั้งที่กรอกของรหัสชุดใหม่จากศูนย์
   *
   * รหัสชุดใหม่แทนที่ชุดเก่าที่ Supabase (เก็บรหัสล่าสุดตัวเดียว) → รหัสเก่าใช้ไม่ได้ (E8)
   * ครั้งที่กรอกผิดของชุดเก่าจึงไม่ควรติดมาด้วย
   */
  recordSent(
    channel: OtpChannel,
    phoneKey: string,
    ip: string | null,
    now: number,
  ): void {
    this.perPhoneCooldown.record(phoneKey, now);
    this.perPhoneDaily.record(phoneKey, now);
    if (ip) this.perIp.record(ip, now);
    this.setRecord(this.otpKey(channel, phoneKey), {
      expiresAt: now + this.config.otpExpiresSeconds * 1000,
      attempts: 0,
      touchedAt: now,
    });
  }

  /**
   * ส่งไม่สำเร็จ (E11) → ไม่กินโควตาของเบอร์ ผู้ใช้กดลองใหม่ได้ทันที
   * แต่ยังนับต่อ IP — ไม่งั้นคนยิงคำขอที่ล้มเหลวรัว ๆ จะไม่มีอะไรหยุด
   */
  recordSendFailed(ip: string | null, now: number): void {
    if (ip) this.perIp.record(ip, now);
  }

  // ─── การตรวจรหัส ─────────────────────────────────────────────────────────

  /**
   * จอง "1 ครั้งที่กรอก" ก่อนส่งรหัสไปให้ Supabase ตรวจ — false = กรอกครบจำนวนแล้ว (E9)
   *
   * ★ จองก่อน ไม่ใช่นับหลังได้ผล: ถ้านับหลัง await คนที่ยิงคำขอเดารหัสพร้อมกัน 50 คำขอ
   *   จะผ่านการเช็คได้ทั้ง 50 (ยังไม่มีคำขอไหนนับเสร็จ) — จองแบบ sync ก่อน await ปิดช่องนี้
   * ★ ไม่รู้จักรหัสชุดนี้ (restart / ไม่ได้ส่งผ่าน instance นี้) ก็ยังนับ — เริ่มที่ record ใหม่
   */
  reserveAttempt(channel: OtpChannel, phoneKey: string, now: number): boolean {
    const key = this.otpKey(channel, phoneKey);
    const record = this.otps.get(key) ?? {
      expiresAt: null,
      attempts: 0,
      touchedAt: now,
    };
    if (record.attempts >= this.config.maxAttempts) {
      record.touchedAt = now;
      this.setRecord(key, record);
      return false;
    }
    record.attempts += 1;
    record.touchedAt = now;
    this.setRecord(key, record);
    return true;
  }

  /**
   * คืนครั้งที่จองไว้ — ใช้เมื่อการตรวจล้มเพราะระบบ ไม่ใช่เพราะรหัสผิด
   * (Supabase ล่ม / หมดเวลา / ถูก rate limit) → ไม่นับเป็นการกรอกผิด (E11)
   */
  refundAttempt(channel: OtpChannel, phoneKey: string): void {
    const record = this.otps.get(this.otpKey(channel, phoneKey));
    if (record && record.attempts > 0) record.attempts -= 1;
  }

  /**
   * Supabase ปฏิเสธรหัส → ตัดสินว่าบอกผู้ใช้ว่าอะไร
   *
   * ลำดับความสำคัญ:
   *   1. หมดอายุแล้ว → 'expired' (ต่อให้กรอกครบจำนวน ทางแก้ก็คือขอรหัสใหม่เหมือนกัน แต่บอกเหตุผลที่ตรงกว่า)
   *   2. กรอกครบจำนวนแล้ว (นับครั้งนี้ด้วย) → 'exceeded' — บอกทันทีตั้งแต่ครั้งสุดท้าย ไม่ต้องรอครั้งถัดไป
   *   3. นอกนั้น → 'invalid'
   */
  rejectionVerdict(
    channel: OtpChannel,
    phoneKey: string,
    now: number,
  ): OtpRejection {
    const record = this.otps.get(this.otpKey(channel, phoneKey));
    if (!record) return 'invalid';
    if (record.expiresAt !== null && now >= record.expiresAt) return 'expired';
    if (record.attempts >= this.config.maxAttempts) return 'exceeded';
    return 'invalid';
  }

  /** ตรวจผ่านแล้ว — รหัสชุดนี้ถูกใช้ไปแล้ว (Supabase ใช้ได้ครั้งเดียว) ลืมได้ */
  markVerified(channel: OtpChannel, phoneKey: string): void {
    this.otps.delete(this.otpKey(channel, phoneKey));
  }

  /** จำนวน record ที่จำอยู่ — มีไว้ให้เทสเช็คว่าหน่วยความจำไม่บวม */
  get trackedOtps(): number {
    return this.otps.size;
  }

  // ─── ภายใน ───────────────────────────────────────────────────────────────

  private otpKey(channel: OtpChannel, phoneKey: string): string {
    return `${channel}:${phoneKey}`;
  }

  /**
   * บันทึก record + กวาดของเก่าทิ้ง + กันหน่วยความจำบวม
   *
   * เก็บ record ไว้นานกว่าอายุรหัส 1 ชม. — นานพอให้ "กรอกครบจำนวนแล้ว" ยังมีผลกับรหัสที่ยังไม่หมดอายุ
   * หลังจากนั้นรหัสหมดอายุแน่นอน Supabase ปฏิเสธเองอยู่แล้ว ไม่ต้องจำต่อ
   */
  private setRecord(key: string, record: OtpRecord): void {
    const now = record.touchedAt;
    const retentionMs = this.config.otpExpiresSeconds * 1000 + HOUR_MS;
    if (now - this.lastSweepAt >= 60_000) {
      this.lastSweepAt = now;
      for (const [k, r] of this.otps) {
        if (now - r.touchedAt > retentionMs) this.otps.delete(k);
      }
    }
    if (!this.otps.has(key) && this.otps.size >= this.maxKeys) {
      // Map จำลำดับการเพิ่ม → ตัวแรกคือตัวที่เก่าที่สุด ทิ้งตัวนั้น (ผ่อนให้คนนั้นเล็กน้อย ดีกว่าเซิร์ฟเวอร์ล่ม)
      for (const oldest of this.otps.keys()) {
        this.otps.delete(oldest);
        break;
      }
    }
    // ลบแล้วใส่ใหม่ = ย้ายไปท้าย Map → ลำดับใน Map คือ "แตะล่าสุดอยู่ท้าย" ใช้ทิ้งตัวเก่าสุดได้ถูกตัว
    this.otps.delete(key);
    this.otps.set(key, record);
  }
}
