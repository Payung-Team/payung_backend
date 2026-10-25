import {
  EMAIL_MAX_LENGTH,
  isAppEmail,
  normalizeEmail,
} from './valid-app-email.validator';

/** อีเมลยาว n ตัวอักษร โครงถูกต้อง (local 64 · label ≤ 63) */
function emailOfLength(n: number): string {
  const local = 'a'.repeat(64);
  let rest = n - 65 - 4;
  const labels: string[] = [];
  while (rest > 0) {
    const l = Math.min(63, rest);
    labels.push('b'.repeat(l));
    rest -= l + 1;
  }
  return `${local}@${labels.join('.')}.com`;
}

const check = (raw: string) => isAppEmail(normalizeEmail(raw));

describe('ValidAppEmail (PYG-707)', () => {
  describe('normalizeEmail', () => {
    it.each([
      ['User@Example.COM', 'user@example.com'],
      ['  user@example.com  ', 'user@example.com'],
      ['\tuser@example.com\n', 'user@example.com'],
      ['\u00a0user@example.com\u00a0', 'user@example.com'],
      ['\ufeffuser@example.com', 'user@example.com'],
      ['user@example.com\u200b', 'user@example.com'],
      ['\u2060 user@example.com \u200d', 'user@example.com'],
    ])('%j → %j', (raw, normalized) => {
      expect(normalizeEmail(raw)).toBe(normalized);
    });

    it('leaves non-strings for the validator to reject', () => {
      expect(normalizeEmail(42)).toBe(42);
      expect(normalizeEmail(null)).toBeNull();
    });
  });

  describe('ผ่าน', () => {
    it.each([
      'user@example.com',
      'user.name@example.co.th',
      'user+tag@example.com',
      'user_name123@sub.domain.com',
      'User@Example.COM',
      'first-last@my-domain.co.th',
      'a%b@example.com',
      'x@ab.io',
      'user@xn--72c1a1bt4awk9o.com', // domain ไทยแบบ punycode ที่เบราว์เซอร์แปลงให้แล้ว
      ' user@example.com ', // ช่องว่างหน้า/หลัง ถูกตัดก่อนตรวจ
      'a'.repeat(64) + '@example.com',
      emailOfLength(EMAIL_MAX_LENGTH),
    ])('%j', (email) => {
      expect(check(email)).toBe(true);
    });
  });

  describe('ไม่ผ่าน', () => {
    it.each([
      // โครงสร้าง
      ['ค่าว่าง', ''],
      ['ช่องว่างล้วน', '   '],
      ['ไม่มี @', 'userexample.com'],
      ['ไม่มี domain', 'user@'],
      ['ไม่มี local part', '@example.com'],
      ['ไม่มี TLD', 'user@example'],
      ['@ สองตัว', 'user@@example.com'],
      ['@ สองที่', 'user@ex@ample.com'],
      // local part
      ['ช่องว่างกลาง', 'user name@example.com'],
      ['จุดติดกัน', 'user..name@example.com'],
      ['ขึ้นต้นด้วยจุด', '.user@example.com'],
      ['ลงท้ายด้วยจุด', 'user.@example.com'],
      ['!#', 'user!#@example.com'],
      ['อักขระพิเศษอื่น', "o'brien@example.com"],
      ['quoted local', '"user name"@example.com'],
      ['comment', 'user(comment)@example.com'],
      ['local ยาว 65', 'a'.repeat(65) + '@example.com'],
      // domain
      ['domain ขึ้นต้นด้วยจุด', 'user@.example.com'],
      ['จุดติดกันใน domain', 'user@example..com'],
      ['domain ลงท้ายด้วยจุด', 'user@example.com.'],
      ['label ขึ้นต้นด้วย -', 'user@-example.com'],
      ['label ลงท้ายด้วย -', 'user@example-.com'],
      ['label ยาว 64', `user@${'b'.repeat(64)}.com`],
      ['TLD ตัวเดียว', 'user@example.c'],
      ['TLD เป็นตัวเลข', 'user@example.123'],
      ['IP', 'user@192.168.0.1'],
      ['IP ในวงเล็บ', 'user@[192.168.0.1]'],
      ['underscore ใน domain', 'user@ex_ample.com'],
      // ความยาว
      ['ยาว 255', emailOfLength(EMAIL_MAX_LENGTH + 1)],
      // ภาษาไทย / Unicode
      ['ภาษาไทยใน local', 'ผู้ใช้@example.com'],
      ['ภาษาไทยใน domain', 'user@ตัวอย่าง.com'],
      ['ตัวอักษรหน้าตาเหมือน (Cyrillic e)', 'us\u0435r@example.com'],
      ['full-width @', 'user\uff20example.com'],
      // อักขระซ่อน (copy-paste) ที่อยู่ "ข้างใน" — หัว/ท้ายถูกตัดใน normalizeEmail
      ['zero-width space กลาง', 'us\u200ber@example.com'],
      ['zero-width joiner', 'user\u200d@example.com'],
      ['word joiner', 'user@exam\u2060ple.com'],
      ['soft hyphen', 'user@exa\u00adple.com'],
      ['NBSP กลาง', 'user\u00a0name@example.com'],
      ['tab กลาง', 'user\tname@example.com'],
      ['ขึ้นบรรทัดใหม่กลาง', 'user@example.com\nbcc@evil.com'],
      ['null byte', 'user\u0000@example.com'],
    ])('%s: %j', (_what, email) => {
      expect(check(email)).toBe(false);
    });

    it.each([undefined, null, 42, {}, ['user@example.com']])(
      'non-string %j',
      (value) => {
        expect(isAppEmail(normalizeEmail(value))).toBe(false);
      },
    );
  });
});
