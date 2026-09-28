/**
 * PYG-474 — เทสของ helper หลักฐานประกอบคำขอ (IP + user agent)
 *
 * ★ เหตุผลหลักที่ต้องเทส: คอลัมน์ user_consents.ip_address เป็น `inet`
 *   ค่าที่ไม่ใช่ IP หลุดเข้าไปแม้ตัวเดียว = ทรานแซคชันล้ม = สมัครสมาชิกไม่ผ่าน
 *   ทุกเคสด้านล่างจึงยืนยันว่า "ได้ IP ที่ถูกต้อง หรือได้ null" ไม่มีทางอื่น
 */
import {
  clientIpOf,
  MAX_USER_AGENT_LENGTH,
  normalizeIp,
  rateLimitIpOf,
  requestEvidenceOf,
  userAgentOf,
} from './request-evidence';

/** สร้าง request ปลอมเท่าที่ helper ใช้ */
function req(headers: Record<string, string | string[]>, ip?: string) {
  return { headers, ip } as unknown as Parameters<typeof clientIpOf>[0];
}

describe('request-evidence (PYG-474)', () => {
  describe('normalizeIp', () => {
    it.each([
      ['203.0.113.9', '203.0.113.9'],
      ['  203.0.113.9  ', '203.0.113.9'],
      // Azure App Service แปะพอร์ตมากับ X-Forwarded-For
      ['203.0.113.9:51234', '203.0.113.9'],
      ['2001:db8::1', '2001:db8::1'],
      ['[2001:db8::1]:443', '2001:db8::1'],
      ['[2001:db8::1]', '2001:db8::1'],
      // IPv4-mapped IPv6 ที่ Node คืนเป็น req.ip บ่อย ๆ — inet รับได้
      ['::ffff:127.0.0.1', '::ffff:127.0.0.1'],
      // inet ไม่รับ zone id
      ['fe80::1%eth0', 'fe80::1'],
    ])('%s → %s', (input, expected) => {
      expect(normalizeIp(input)).toBe(expected);
    });

    it.each([
      ['unknown'],
      [''],
      ['   '],
      ['999.1.1.1'],
      ['1.2.3'],
      ['not-an-ip:80'],
    ])('ค่าที่ไม่ใช่ IP (%s) → null (ห้ามหลุดไปถึงคอลัมน์ inet)', (input) => {
      expect(normalizeIp(input)).toBeNull();
    });

    it('null / undefined → null', () => {
      expect(normalizeIp(null)).toBeNull();
      expect(normalizeIp(undefined)).toBeNull();
    });
  });

  describe('clientIpOf', () => {
    it('ใช้ค่าแรกของ X-Forwarded-For (client) ไม่ใช่ proxy ตัวถัดไป', () => {
      expect(
        clientIpOf(
          req({ 'x-forwarded-for': '203.0.113.9, 10.0.0.1' }, '10.0.0.2'),
        ),
      ).toBe('203.0.113.9');
    });

    it('X-Forwarded-For เป็น array → ใช้ตัวแรก', () => {
      expect(
        clientIpOf(req({ 'x-forwarded-for': ['203.0.113.9', '10.0.0.1'] })),
      ).toBe('203.0.113.9');
    });

    it('★ X-Forwarded-For เป็นค่าขยะ → ถอยไปใช้ req.ip แทนการบันทึกค่าผิด', () => {
      expect(
        clientIpOf(req({ 'x-forwarded-for': 'unknown' }, '198.51.100.7')),
      ).toBe('198.51.100.7');
    });

    it('ไม่มี X-Forwarded-For → ใช้ req.ip', () => {
      expect(clientIpOf(req({}, '198.51.100.7'))).toBe('198.51.100.7');
    });

    it('ไม่มีอะไรที่เป็น IP เลย → null', () => {
      expect(
        clientIpOf(req({ 'x-forwarded-for': 'garbage' }, 'also-garbage')),
      ).toBeNull();
      expect(clientIpOf(req({}))).toBeNull();
    });
  });

  describe('userAgentOf', () => {
    it('คืน user agent ที่ trim แล้ว', () => {
      expect(userAgentOf(req({ 'user-agent': '  Mozilla/5.0  ' }))).toBe(
        'Mozilla/5.0',
      );
    });

    it('ไม่มี header หรือเป็นช่องว่างล้วน → null', () => {
      expect(userAgentOf(req({}))).toBeNull();
      expect(userAgentOf(req({ 'user-agent': '   ' }))).toBeNull();
    });

    it(`ยาวเกิน ${MAX_USER_AGENT_LENGTH} ตัวอักษร → ตัดทิ้ง (กันถมตาราง)`, () => {
      const huge = 'x'.repeat(MAX_USER_AGENT_LENGTH + 100);
      expect(userAgentOf(req({ 'user-agent': huge }))).toHaveLength(
        MAX_USER_AGENT_LENGTH,
      );
    });
  });

  it('requestEvidenceOf รวมทั้งสองค่า', () => {
    expect(
      requestEvidenceOf(
        req({
          'x-forwarded-for': '203.0.113.9:4000',
          'user-agent': 'jest/1.0',
        }),
      ),
    ).toEqual({ ipAddress: '203.0.113.9', userAgent: 'jest/1.0' });
  });

  // PYG-479 — IP ที่ใช้เป็น key ของ rate limit ต้อง "ไม่ใช่ค่าที่ client แต่งเองได้"
  describe('rateLimitIpOf (PYG-479)', () => {
    it('เอาค่าขวาสุดของ X-Forwarded-For (ค่าที่ proxy ของเราต่อท้ายให้) ไม่ใช่ซ้ายสุด', () => {
      // client แต่ง 1.1.1.1 มาเอง → proxy ต่อท้ายด้วย IP จริงที่ต่อเข้ามา
      const r = req({ 'x-forwarded-for': '1.1.1.1, 203.0.113.9:51234' });
      expect(rateLimitIpOf(r)).toBe('203.0.113.9');
      // เทียบให้เห็นว่าต่างจาก clientIpOf โดยตั้งใจ
      expect(clientIpOf(r)).toBe('1.1.1.1');
    });

    it('ส่ง X-Forwarded-For สุ่มมาทุกครั้ง ก็ยังได้ key เดิม (หนีการจำกัดต่อ IP ไม่ได้)', () => {
      const keys = ['9.9.9.1', '9.9.9.2', '9.9.9.3'].map((spoofed) =>
        rateLimitIpOf(req({ 'x-forwarded-for': `${spoofed}, 203.0.113.9` })),
      );
      expect(new Set(keys)).toEqual(new Set(['203.0.113.9']));
    });

    it('ไม่มี header (เรียกตรง ไม่ผ่าน proxy) → ใช้ req.ip', () => {
      expect(rateLimitIpOf(req({}, '::ffff:127.0.0.1'))).toBe(
        '::ffff:127.0.0.1',
      );
    });

    it('header หลายตัว (array) → เอาค่าท้ายสุดของตัวสุดท้าย', () => {
      expect(
        rateLimitIpOf(req({ 'x-forwarded-for': ['1.1.1.1', '203.0.113.9'] })),
      ).toBe('203.0.113.9');
    });

    it('ค่าขวาสุดไม่ใช่ IP → ถอยไปใช้ req.ip · ไม่ได้ทั้งคู่ → null', () => {
      expect(
        rateLimitIpOf(req({ 'x-forwarded-for': 'garbage' }, '10.0.0.5')),
      ).toBe('10.0.0.5');
      expect(rateLimitIpOf(req({ 'x-forwarded-for': 'garbage' }))).toBeNull();
    });
  });
});
