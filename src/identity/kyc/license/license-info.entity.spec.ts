/**
 * LicenseInfo.isExpired - BE คำนวณให้ FE (PYG-587 / contract PYG-585)
 */
import { pickLatestLicense } from './license-info.entity';

const endOfDay = (ymd: string) => new Date(new Date(`${ymd}T00:00:00Z`).getTime() + 17 * 3600 * 1000 - 1);
const doc = (over: Record<string, unknown> = {}) =>
  ({
    id: 'd1',
    docType: 'professional_license',
    fileName: 'l.pdf',
    reviewStatus: 'approved',
    expiresAt: endOfDay('2026-12-31'),
    ...over,
  }) as never;

describe('pickLatestLicense.isExpired', () => {
  const NOW = new Date('2026-10-18T03:00:00Z'); // 10:00 ไทย

  it('ยังไม่ถึงวันหมดอายุ -> false', () => {
    expect(pickLatestLicense([doc()], NOW)?.isExpired).toBe(false);
  });

  it('วันหมดอายุคือวันนี้ (ก่อนสิ้นวันไทย) -> false', () => {
    expect(pickLatestLicense([doc({ expiresAt: endOfDay('2026-10-18') })], NOW)?.isExpired).toBe(false);
  });

  it('เลยสิ้นวันหมดอายุแล้วแต่งานรายวันยังไม่เปลี่ยนสถานะ (status ยัง approved) -> true', () => {
    const info = pickLatestLicense([doc({ expiresAt: endOfDay('2026-10-17') })], NOW);
    expect(info).toMatchObject({ status: 'approved', isExpired: true });
  });

  it('ข้ามเที่ยงคืนไทย: 00:00 ของวันถัดไป -> true', () => {
    const rows = [doc({ expiresAt: endOfDay('2026-10-18') })];
    expect(pickLatestLicense(rows, new Date('2026-10-18T16:59:59.998Z'))?.isExpired).toBe(false);
    expect(pickLatestLicense(rows, new Date('2026-10-18T17:00:00.000Z'))?.isExpired).toBe(true);
  });

  it('status = expired -> true เสมอ', () => {
    expect(pickLatestLicense([doc({ reviewStatus: 'expired' })], NOW)?.isExpired).toBe(true);
  });

  it('ไม่มีวันหมดอายุ และไม่ใช่ expired -> false', () => {
    expect(pickLatestLicense([doc({ expiresAt: undefined })], NOW)?.isExpired).toBe(false);
  });

  it('ไม่มีใบประกอบฯ -> undefined', () => {
    expect(pickLatestLicense([doc({ docType: 'certificate' })], NOW)).toBeUndefined();
  });
});
