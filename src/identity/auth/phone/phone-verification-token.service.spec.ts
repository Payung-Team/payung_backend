/**
 * PYG-603 — เทสตั๋ว verificationToken ของการสมัครด้วยเบอร์
 *
 * ธีม: อ่านคืนได้ · แก้ไขไม่ได้ · หมดอายุได้ · คนละกุญแจอ่านไม่ได้ · ไม่มีข้อมูลข้างในให้อ่านออก
 *      และ production ที่ลืมตั้งกุญแจต้องไม่ทำให้แอปบูตไม่ขึ้น
 */
import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { GraphQLError } from 'graphql';
import {
  PHONE_VERIFICATION_TOKEN_SECRET_ENV,
  PhoneVerificationTokenService,
} from './phone-verification-token.service';

const SECRET = 'test-secret-that-is-at-least-32-characters-long';
const CLAIMS = {
  uid: 'sb-uid-1',
  phone: '+66812345678',
  rt: 'refresh-token-abc',
};
const NOW = Date.UTC(2026, 9, 16, 3, 0, 0);

function serviceWith(
  secret: string | undefined,
): PhoneVerificationTokenService {
  const config = {
    get: (key: string) =>
      key === PHONE_VERIFICATION_TOKEN_SECRET_ENV ? secret : undefined,
  } as unknown as ConfigService;
  return new PhoneVerificationTokenService(config);
}

describe('PhoneVerificationTokenService', () => {
  beforeEach(() => {
    // ไม่ให้คำเตือนเรื่องกุญแจรก output ของเทส
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('ออกตั๋วแล้วอ่านคืนได้ครบ', () => {
    const svc = serviceWith(SECRET);
    const token = svc.seal(CLAIMS, 1800, NOW);
    expect(token.startsWith('v1.')).toBe(true);
    expect(svc.open(token, NOW + 60_000)).toEqual(CLAIMS);
  });

  it('★ อ่านเนื้อหาจากตั๋วไม่ออก — refresh token / เบอร์ ไม่ปรากฏในตั๋ว', () => {
    const token = serviceWith(SECRET).seal(CLAIMS, 1800, NOW);
    const decoded = Buffer.from(token.slice(3), 'base64url').toString('latin1');
    expect(decoded).not.toContain(CLAIMS.rt);
    expect(decoded).not.toContain('812345678');
    expect(token).not.toContain(CLAIMS.rt);
  });

  it('หมดอายุแล้ว → null', () => {
    const svc = serviceWith(SECRET);
    const token = svc.seal(CLAIMS, 1800, NOW);
    expect(svc.open(token, NOW + 1799_000)).toEqual(CLAIMS);
    expect(svc.open(token, NOW + 1800_000)).toBeNull();
  });

  it('แก้ไบต์เดียว → null (GCM กันการแก้ไข)', () => {
    const svc = serviceWith(SECRET);
    const token = svc.seal(CLAIMS, 1800, NOW);
    const bytes = Buffer.from(token.slice(3), 'base64url');
    bytes[bytes.length - 1] ^= 0x01;
    expect(svc.open(`v1.${bytes.toString('base64url')}`, NOW)).toBeNull();
  });

  it('คนละกุญแจ → null', () => {
    const token = serviceWith(SECRET).seal(CLAIMS, 1800, NOW);
    expect(serviceWith(`${SECRET}-other`).open(token, NOW)).toBeNull();
  });

  it.each([
    [''],
    ['not-a-token'],
    ['v1.'],
    ['v1.@@@'],
    [`v1.${'A'.repeat(5000)}`],
    [12345],
    [null],
  ])('ตั๋วผิดรูปแบบ %p → null (ไม่ throw)', (bad) => {
    expect(serviceWith(SECRET).open(bad, NOW)).toBeNull();
  });

  describe('ไม่ได้ตั้งกุญแจ', () => {
    const originalEnv = process.env.NODE_ENV;
    afterEach(() => {
      process.env.NODE_ENV = originalEnv;
    });

    it('dev/test: ใช้กุญแจสุ่มชั่วคราว — ยังใช้งานได้', () => {
      process.env.NODE_ENV = 'development';
      const svc = serviceWith(undefined);
      expect(svc.open(svc.seal(CLAIMS, 60, NOW), NOW)).toEqual(CLAIMS);
    });

    it('กุญแจสั้นเกินไป = ถือว่าไม่ได้ตั้ง', () => {
      process.env.NODE_ENV = 'production';
      expect(() => serviceWith('short').seal(CLAIMS, 60, NOW)).toThrow(
        GraphQLError,
      );
    });

    it('★ production: สร้าง service ได้ (แอปบูตขึ้น) แต่ออก/อ่านตั๋วไม่ได้', () => {
      process.env.NODE_ENV = 'production';
      const svc = serviceWith(undefined); // ไม่ throw ตอนสร้าง
      expect(() => svc.seal(CLAIMS, 60, NOW)).toThrow(GraphQLError);
      expect(() => svc.open('v1.x', NOW)).toThrow(GraphQLError);
    });
  });
});
