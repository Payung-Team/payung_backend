/**
 * PYG-603 — เทสตัวคุมจังหวะการขอรหัสและนับครั้งที่กรอกผิด (R8, E7–E11)
 */
import { PHONE_AUTH_DEFAULTS, type PhoneAuthConfig } from './phone-auth.config';
import { PhoneOtpTracker } from './phone-otp-tracker';

const PHONE = '+66812345678';
const OTHER = '+66899999999';
const IP = '203.0.113.9';
const T0 = Date.UTC(2026, 9, 16, 3, 0, 0);
const SEC = 1000;

function tracker(
  overrides: Partial<PhoneAuthConfig> = {},
  maxKeys?: number,
): PhoneOtpTracker {
  return new PhoneOtpTracker({ ...PHONE_AUTH_DEFAULTS, ...overrides }, maxKeys);
}

describe('PhoneOtpTracker — การขอรหัส', () => {
  it('ส่งแล้วต้องรอ cooldown ก่อนขอเบอร์เดิมได้อีก (E10) · เบอร์อื่นไม่เกี่ยว', () => {
    const t = tracker({ resendCooldownSeconds: 60 });
    expect(t.sendWaitSeconds(PHONE, IP, T0)).toBe(0);
    t.recordSent('sms', PHONE, IP, T0);

    expect(t.sendWaitSeconds(PHONE, IP, T0 + 18 * SEC)).toBe(42);
    expect(t.sendWaitSeconds(PHONE, IP, T0 + 59.5 * SEC)).toBe(1); // ปัดขึ้น ไม่ใช่ 0
    expect(t.sendWaitSeconds(PHONE, IP, T0 + 60 * SEC)).toBe(0);
    expect(t.sendWaitSeconds(OTHER, IP, T0 + 1 * SEC)).toBe(0);
  });

  it('เพดานต่อเบอร์ต่อวัน', () => {
    const t = tracker({
      resendCooldownSeconds: 1,
      maxSendsPerPhonePerDay: 3,
      maxSendsPerIpPerHour: 100,
    });
    for (let i = 0; i < 3; i += 1)
      t.recordSent('sms', PHONE, null, T0 + i * 10 * SEC);
    const wait = t.sendWaitSeconds(PHONE, null, T0 + 60 * SEC);
    // ครั้งแรก (T0) หลุดหน้าต่าง 24 ชม. ตอน T0 + 24 ชม.
    expect(wait).toBe(24 * 3600 - 60);
  });

  it('เพดานต่อ IP — กันยิงขอรหัสไปหลายเบอร์', () => {
    const t = tracker({ maxSendsPerIpPerHour: 2 });
    t.recordSent('sms', '+66811111111', IP, T0);
    t.recordSent('sms', '+66822222222', IP, T0 + SEC);
    expect(t.sendWaitSeconds('+66833333333', IP, T0 + 2 * SEC)).toBeGreaterThan(
      0,
    );
    expect(
      t.sendWaitSeconds('+66833333333', '198.51.100.1', T0 + 2 * SEC),
    ).toBe(0);
    // หา IP ไม่ได้ → ไม่นับต่อ IP (แต่ยังนับต่อเบอร์)
    expect(t.sendWaitSeconds('+66833333333', null, T0 + 2 * SEC)).toBe(0);
  });

  it('E11: ส่งไม่สำเร็จไม่กินโควตาของเบอร์ แต่ยังนับต่อ IP', () => {
    const t = tracker({ maxSendsPerIpPerHour: 1 });
    t.recordSendFailed(IP, T0);
    expect(t.sendWaitSeconds(PHONE, null, T0 + SEC)).toBe(0); // เบอร์ขอใหม่ได้ทันที
    expect(t.sendWaitSeconds(PHONE, IP, T0 + SEC)).toBeGreaterThan(0); // IP เต็มแล้ว
  });

  it('กันกดซ้ำพร้อมกัน — จองได้ทีละคำขอต่อเบอร์', () => {
    const t = tracker();
    expect(t.tryBeginSend(PHONE)).toBe(true);
    expect(t.tryBeginSend(PHONE)).toBe(false);
    expect(t.tryBeginSend(OTHER)).toBe(true);
    t.endSend(PHONE);
    expect(t.tryBeginSend(PHONE)).toBe(true);
  });
});

describe('PhoneOtpTracker — การกรอกรหัส', () => {
  it('E9: กรอกได้ครบ maxAttempts แล้วจองไม่ได้อีก · ครั้งสุดท้ายตัดสินเป็น exceeded ทันที', () => {
    const t = tracker({ maxAttempts: 3 });
    t.recordSent('sms', PHONE, IP, T0);
    for (let i = 1; i <= 2; i += 1) {
      expect(t.reserveAttempt('sms', PHONE, T0)).toBe(true);
      expect(t.rejectionVerdict('sms', PHONE, T0)).toBe('invalid');
    }
    expect(t.reserveAttempt('sms', PHONE, T0)).toBe(true);
    expect(t.rejectionVerdict('sms', PHONE, T0)).toBe('exceeded');
    expect(t.reserveAttempt('sms', PHONE, T0)).toBe(false); // แม้รหัสถูกก็ไม่ได้ตรวจแล้ว
  });

  it('ขอรหัสใหม่ = เริ่มนับใหม่ (รหัสชุดเก่าใช้ไม่ได้แล้ว · E8)', () => {
    const t = tracker({ maxAttempts: 1 });
    t.recordSent('sms', PHONE, IP, T0);
    t.reserveAttempt('sms', PHONE, T0);
    expect(t.reserveAttempt('sms', PHONE, T0)).toBe(false);
    t.recordSent('sms', PHONE, IP, T0 + 61 * SEC);
    expect(t.reserveAttempt('sms', PHONE, T0 + 62 * SEC)).toBe(true);
  });

  it('E7: เลยอายุรหัสแล้ว → expired (มาก่อน exceeded)', () => {
    const t = tracker({ otpExpiresSeconds: 60, maxAttempts: 1 });
    t.recordSent('sms', PHONE, IP, T0);
    t.reserveAttempt('sms', PHONE, T0 + 61 * SEC);
    expect(t.rejectionVerdict('sms', PHONE, T0 + 61 * SEC)).toBe('expired');
  });

  it('ไม่รู้เวลาส่ง (restart) → invalid ไม่ใช่ expired · แต่ยังนับครั้ง', () => {
    const t = tracker({ maxAttempts: 2 });
    expect(t.reserveAttempt('sms', PHONE, T0)).toBe(true);
    expect(t.rejectionVerdict('sms', PHONE, T0 + 3600 * SEC)).toBe('invalid');
    expect(t.reserveAttempt('sms', PHONE, T0)).toBe(true);
    expect(t.reserveAttempt('sms', PHONE, T0)).toBe(false);
  });

  it('E11: ระบบล้มระหว่างตรวจ → คืนครั้งที่จองไว้ (ไม่นับเป็นกรอกผิด)', () => {
    const t = tracker({ maxAttempts: 1 });
    t.recordSent('sms', PHONE, IP, T0);
    expect(t.reserveAttempt('sms', PHONE, T0)).toBe(true);
    t.refundAttempt('sms', PHONE);
    expect(t.reserveAttempt('sms', PHONE, T0)).toBe(true);
  });

  it('★ SIGNUP กับ LOGIN ใช้ช่อง sms เดียวกัน — เดาสลับ mutation ไม่ได้ครั้งเพิ่ม · LINK แยกช่อง', () => {
    const t = tracker({ maxAttempts: 1 });
    t.recordSent('sms', PHONE, IP, T0);
    t.reserveAttempt('sms', PHONE, T0); // ผ่าน verifyPhoneOtp
    expect(t.reserveAttempt('sms', PHONE, T0)).toBe(false); // ลองต่อผ่าน loginWithPhone ไม่ได้
    expect(t.reserveAttempt('phone_change', PHONE, T0)).toBe(true);
  });

  it('ตรวจผ่านแล้วลืมรหัสชุดนั้น', () => {
    const t = tracker();
    t.recordSent('sms', PHONE, IP, T0);
    t.markVerified('sms', PHONE);
    expect(t.trackedOtps).toBe(0);
  });

  it('หน่วยความจำไม่บวม — record เก่ากว่าอายุรหัส + 1 ชม. ถูกกวาดทิ้ง และมีเพดานจำนวน', () => {
    const t = tracker({ otpExpiresSeconds: 60 }, 3);
    t.recordSent('sms', '+66811111111', null, T0);
    t.recordSent('sms', '+66822222222', null, T0);
    // กวาดตอนแตะครั้งถัดไปที่ห่างพอ
    t.recordSent('sms', '+66833333333', null, T0 + (60 + 3601) * SEC);
    expect(t.trackedOtps).toBe(1);

    for (let i = 0; i < 10; i += 1) {
      t.recordSent('sms', `+6681000000${i}`, null, T0 + (60 + 3601) * SEC + i);
    }
    expect(t.trackedOtps).toBeLessThanOrEqual(3);
  });
});
