/**
 * กฎใบประกอบวิชาชีพ — วันที่ตามเวลาไทย + ความครบของเลข/วันหมดอายุ (PYG-587: E3, E4, E5)
 */
import { bangkokDateString, isBangkokDateInFuture, toBangkokEndOfDay } from './license-date';
import { normalizeLicenseNumber, validateLicenseFields } from './license-validation';
import { LicenseError } from './license.errors';

/** เวลาไทย 2026-10-18 10:00 = 03:00Z */
const NOW = new Date('2026-10-18T03:00:00Z');

function catchLicenseError(fn: () => unknown): LicenseError {
  try {
    fn();
  } catch (e) {
    return e as LicenseError;
  }
  throw new Error('expected LicenseError');
}

describe('license-date (Asia/Bangkok)', () => {
  it('toBangkokEndOfDay: สิ้นวันไทย 23:59:59.999+07 = 16:59:59.999Z', () => {
    expect(toBangkokEndOfDay(new Date('2027-12-31T00:00:00Z')).toISOString()).toBe(
      '2027-12-31T16:59:59.999Z',
    );
  });

  it('รับ timestamp ที่เป็นเที่ยงคืนเวลาไทย (17:00Z วันก่อน) ได้วันเดียวกัน', () => {
    expect(bangkokDateString(new Date('2027-12-30T17:00:00Z'))).toBe('2027-12-31');
    expect(toBangkokEndOfDay(new Date('2027-12-30T17:00:00Z')).toISOString()).toBe(
      '2027-12-31T16:59:59.999Z',
    );
  });

  it('ไม่พึ่งเขตเวลาเครื่อง: 18:30Z ของวันที่ 17 = วันที่ 18 ตามเวลาไทย → วันที่ 18 ไม่ใช่อนาคต', () => {
    const lateUtc = new Date('2026-10-17T18:30:00Z'); // 01:30 ไทยของวันที่ 18
    expect(isBangkokDateInFuture(new Date('2026-10-18T00:00:00Z'), lateUtc)).toBe(false);
    expect(isBangkokDateInFuture(new Date('2026-10-19T00:00:00Z'), lateUtc)).toBe(true);
  });
});

describe('normalizeLicenseNumber (E5)', () => {
  it('ตัดช่องว่างหัวท้าย', () => expect(normalizeLicenseNumber('  N-12345  ')).toBe('N-12345'));
  it('ว่าง/มีแต่ช่องว่าง/null → null', () => {
    expect(normalizeLicenseNumber('   ')).toBeNull();
    expect(normalizeLicenseNumber('')).toBeNull();
    expect(normalizeLicenseNumber(undefined)).toBeNull();
  });
});

describe('validateLicenseFields', () => {
  it('ผ่าน: ตัดช่องว่าง + เก็บเป็นสิ้นวันไทย', () => {
    const r = validateLicenseFields(' N-1 ', new Date('2026-10-19T00:00:00Z'), NOW);
    expect(r.licenseNumber).toBe('N-1');
    expect(r.expiresAt.toISOString()).toBe('2026-10-19T16:59:59.999Z');
  });

  it('E3: วันหมดอายุ = วันนี้ตามเวลาไทย → LICENSE_EXPIRY_NOT_FUTURE', () => {
    const e = catchLicenseError(() =>
      validateLicenseFields('N-1', new Date('2026-10-18T00:00:00Z'), NOW),
    );
    expect(e.extensions.code).toBe('LICENSE_EXPIRY_NOT_FUTURE');
    expect(e.extensions.statusCode).toBe(422);
  });

  it('E4: ย้อนหลัง → LICENSE_EXPIRY_NOT_FUTURE', () => {
    const e = catchLicenseError(() =>
      validateLicenseFields('N-1', new Date('2026-10-01T00:00:00Z'), NOW),
    );
    expect(e.extensions.code).toBe('LICENSE_EXPIRY_NOT_FUTURE');
  });

  it('ไม่มีเลข → LICENSE_NUMBER_REQUIRED · เลขมีแต่ช่องว่างก็ถือว่าไม่มี (E5)', () => {
    const future = new Date('2027-01-01T00:00:00Z');
    expect(catchLicenseError(() => validateLicenseFields(undefined, future, NOW)).extensions.code).toBe(
      'LICENSE_NUMBER_REQUIRED',
    );
    expect(catchLicenseError(() => validateLicenseFields('   ', future, NOW)).extensions.code).toBe(
      'LICENSE_NUMBER_REQUIRED',
    );
  });

  it('ไม่มีวันหมดอายุ → LICENSE_EXPIRY_REQUIRED', () => {
    expect(catchLicenseError(() => validateLicenseFields('N-1', undefined, NOW)).extensions.code).toBe(
      'LICENSE_EXPIRY_REQUIRED',
    );
  });

  it('ขาดหลายช่อง → ตอบครบในครั้งเดียว (codes) · code = ช่องแรก', () => {
    const e = catchLicenseError(() => validateLicenseFields(' ', undefined, NOW));
    expect(e.extensions.code).toBe('LICENSE_NUMBER_REQUIRED');
    expect(e.extensions.codes).toEqual(['LICENSE_NUMBER_REQUIRED', 'LICENSE_EXPIRY_REQUIRED']);
  });

  it('เลขยาวเกิน 50 หลังตัดช่องว่าง → LICENSE_NUMBER_TOO_LONG', () => {
    const e = catchLicenseError(() =>
      validateLicenseFields('x'.repeat(51), new Date('2027-01-01T00:00:00Z'), NOW),
    );
    expect(e.extensions.code).toBe('LICENSE_NUMBER_TOO_LONG');
  });
});
