/**
 * PYG-603 — เทสการแปลง error ของ Supabase Auth เป็นประเภทความล้มเหลวที่ service ใช้
 *
 * ★ ทดสอบเฉพาะ toGatewayError (pure function) — การคุยกับ Supabase จริงทดสอบไม่ได้ใน unit test
 *   (ต้องเปิด phone provider + ผู้ให้บริการ SMS) · dev/QA ใช้ "Test Phone Numbers" ของ Supabase แทน
 */
import { PhoneGatewayError } from './phone-auth.gateway';
import { toGatewayError } from './supabase-phone-auth.gateway';

describe('toGatewayError — error ของ Supabase → ประเภทความล้มเหลว', () => {
  it.each([
    ['otp_expired', 403, 'otp_rejected'], // Supabase ใช้ตัวนี้ทั้งรหัสผิดและหมดอายุ
    ['over_sms_send_rate_limit', 429, 'rate_limited'],
    ['over_request_rate_limit', 429, 'rate_limited'],
    ['sms_send_failed', 500, 'sms_failed'], // E11
    ['phone_provider_disabled', 422, 'sms_failed'], // ยังไม่ได้เปิด phone provider
    ['phone_exists', 422, 'phone_taken'], // E5
    ['otp_disabled', 422, 'no_account'], // shouldCreateUser: false แต่ไม่มีผู้ใช้
    ['refresh_token_already_used', 400, 'session_invalid'],
    ['refresh_token_not_found', 400, 'session_invalid'],
    ['validation_failed', 400, 'phone_invalid'],
    ['unexpected_failure', 500, 'unavailable'],
  ])('code %s (HTTP %s) → %s', (code, status, kind) => {
    expect(toGatewayError({ code, status, message: 'x' }).kind).toBe(kind);
  });

  it('ไม่มี code แต่ 429 → rate_limited และดึงวินาทีจากข้อความ', () => {
    const err = toGatewayError({
      status: 429,
      message:
        'For security purposes, you can only request this after 42 seconds.',
    });
    expect(err.kind).toBe('rate_limited');
    expect(err.retryAfterSeconds).toBe(42);
  });

  it('ไม่มี code แต่ 403 "Token has expired or is invalid" → otp_rejected (Supabase เวอร์ชันเก่า)', () => {
    expect(
      toGatewayError({
        status: 403,
        message: 'Token has expired or is invalid',
      }).kind,
    ).toBe('otp_rejected');
  });

  it('เครือข่ายล่ม (ไม่มี code ไม่มี status) → unavailable', () => {
    expect(toGatewayError(new TypeError('fetch failed')).kind).toBe(
      'unavailable',
    );
    expect(toGatewayError(undefined).kind).toBe('unavailable');
  });

  it('PhoneGatewayError ที่แปลงแล้วผ่านไปตามเดิม', () => {
    const original = new PhoneGatewayError('sms_failed');
    expect(toGatewayError(original)).toBe(original);
  });
});
