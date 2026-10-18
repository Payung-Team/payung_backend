/**
 * PYG-603 — ชื่อแสดงที่ "ระบบตั้งให้ตอนสมัคร" (ใช้ตัดสินว่า Onboarding ทับด้วยชื่อจริงได้ไหม)
 *
 * เดิม completeOnboarding เรียก user.email.split('@') ตรง ๆ → บัญชีที่สมัครด้วยเบอร์ (ไม่มีอีเมล)
 * กดบันทึกหน้า Onboarding แล้วได้ 500 · ตอนนี้ตัดสินผ่าน isSystemDefaultDisplayName
 */
import { isSystemDefaultDisplayName } from './user.service';

describe('isSystemDefaultDisplayName', () => {
  it('สมัครด้วยอีเมล: ชื่อ = prefix ของอีเมล → ค่าที่ระบบตั้ง (ทับได้)', () => {
    expect(isSystemDefaultDisplayName('somsri', 'somsri@example.com')).toBe(
      true,
    );
  });

  it('ผู้ใช้ตั้งชื่อเองแล้ว → ไม่ทับ', () => {
    expect(
      isSystemDefaultDisplayName('คุณยายสมศรี', 'somsri@example.com'),
    ).toBe(false);
  });

  it('สมัครด้วยเบอร์: ไม่มีอีเมล ชื่อเป็น null → ค่าที่ระบบตั้ง (ทับได้) และไม่ throw', () => {
    expect(isSystemDefaultDisplayName(null, null)).toBe(true);
  });

  it('สมัครด้วยเบอร์แล้วตั้งชื่อเอง → ไม่ทับ', () => {
    expect(isSystemDefaultDisplayName('สมศรี', null)).toBe(false);
  });
});
