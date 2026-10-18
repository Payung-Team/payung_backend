/**
 * PYG-603 — เทสการอ่านค่า R8 จาก env (ไม่ฝังตัวเลขในโค้ด)
 */
import { loadPhoneAuthConfig, PHONE_AUTH_DEFAULTS } from './phone-auth.config';

describe('loadPhoneAuthConfig', () => {
  it('ไม่ตั้ง env → ค่าเริ่มต้น (ตรงกับค่าเริ่มต้นของ Supabase: รหัส 60 วินาที, ขอใหม่ได้ทุก 60 วินาที)', () => {
    const config = loadPhoneAuthConfig(() => undefined);
    expect(config).toEqual(PHONE_AUTH_DEFAULTS);
    expect(config.otpExpiresSeconds).toBe(60);
    expect(config.resendCooldownSeconds).toBe(60);
  });

  it('อ่านค่าจาก env ได้ทุกตัว', () => {
    const env: Record<string, string> = {
      PHONE_OTP_EXPIRES_SECONDS: '300',
      PHONE_OTP_RESEND_COOLDOWN_SECONDS: '90',
      PHONE_OTP_MAX_ATTEMPTS: '3',
      PHONE_OTP_MAX_SENDS_PER_PHONE_PER_DAY: '6',
      PHONE_OTP_MAX_SENDS_PER_IP_PER_HOUR: '30',
      PHONE_VERIFICATION_TOKEN_TTL_SECONDS: '600',
    };
    expect(loadPhoneAuthConfig((k) => env[k])).toEqual({
      otpExpiresSeconds: 300,
      resendCooldownSeconds: 90,
      maxAttempts: 3,
      maxSendsPerPhonePerDay: 6,
      maxSendsPerIpPerHour: 30,
      verificationTokenTtlSeconds: 600,
    });
  });

  it.each([['abc'], ['0'], ['-5'], ['1.5']])(
    'ค่าผิด "%s" → ใช้ค่าเริ่มต้น + เตือน (ไม่ทำให้แอปบูตไม่ขึ้น)',
    (bad) => {
      const onInvalid = jest.fn();
      const config = loadPhoneAuthConfig(
        (k) => (k === 'PHONE_OTP_MAX_ATTEMPTS' ? bad : undefined),
        onInvalid,
      );
      expect(config.maxAttempts).toBe(PHONE_AUTH_DEFAULTS.maxAttempts);
      expect(onInvalid).toHaveBeenCalledWith('PHONE_OTP_MAX_ATTEMPTS', bad);
    },
  );
});
