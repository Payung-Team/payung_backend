/**
 * computeDrivingLicenseState — จุดเดียวที่คำนวณ "ผ่านการตรวจใบขับขี่" (PYG-597: R5, R9, E3, E7, E8)
 */
import { computeDrivingLicenseState, DrivingLicenseRow } from './driving-license-status';

/** สิ้นวันเวลาไทย (ค่าที่ DB เก็บ) ของวันที่ระบุ */
const endOfDay = (ymd: string) => new Date(new Date(`${ymd}T00:00:00Z`).getTime() + 17 * 3600 * 1000 - 1);
/** เวลาไทย hh:mm ของวันที่ระบุ -> instant */
const bkk = (ymd: string, hm: string) => new Date(`${ymd}T${hm}:00+07:00`);

const row = (over: Partial<DrivingLicenseRow> & { id?: string } = {}): DrivingLicenseRow => ({
  id: 'd1',
  reviewStatus: 'approved',
  expiresAt: endOfDay('2026-12-31'),
  uploadedAt: new Date('2026-09-01T00:00:00Z'),
  ...over,
});

const NOW = bkk('2026-10-18', '10:00');

describe('computeDrivingLicenseState', () => {
  it('ไม่เคยอัปโหลด -> none, ไม่ผ่าน, ไม่ isExpired', () => {
    expect(computeDrivingLicenseState([], NOW)).toEqual({ verified: false, status: 'none', isExpired: false });
  });

  it('รอตรวจ -> pending ไม่ผ่าน', () => {
    const s = computeDrivingLicenseState([row({ reviewStatus: 'pending' })], NOW);
    expect(s).toMatchObject({ verified: false, status: 'pending', isExpired: false });
  });

  it('review_status = null นับเป็น pending (ไม่ผ่าน)', () => {
    expect(computeDrivingLicenseState([row({ reviewStatus: null })], NOW)).toMatchObject({
      verified: false,
      status: 'pending',
    });
  });

  it('ถูกปฏิเสธ -> rejected ไม่ผ่าน', () => {
    expect(computeDrivingLicenseState([row({ reviewStatus: 'rejected' })], NOW)).toMatchObject({
      verified: false,
      status: 'rejected',
    });
  });

  it('อนุมัติ + ยังไม่หมดอายุ -> ผ่าน (R5)', () => {
    const s = computeDrivingLicenseState([row()], NOW);
    expect(s).toMatchObject({ verified: true, status: 'approved', isExpired: false, documentId: 'd1' });
    expect(s.expiresAt).toEqual(endOfDay('2026-12-31'));
  });

  it('วันหมดอายุตรงกับวันนี้ ยังผ่าน (วันหมดอายุเองยังใช้ได้) ทั้งต้นวันและก่อนเที่ยงคืนไทย', () => {
    const expiresAt = endOfDay('2026-10-18');
    expect(computeDrivingLicenseState([row({ expiresAt })], bkk('2026-10-18', '00:00')).verified).toBe(true);
    expect(computeDrivingLicenseState([row({ expiresAt })], bkk('2026-10-18', '23:59')).verified).toBe(true);
  });

  it('E3: ข้ามเที่ยงคืนไทยไปวันถัดไป -> verified เป็น false เอง และ isExpired = true โดยไม่มีใครแก้ข้อมูล', () => {
    const rows = [row({ expiresAt: endOfDay('2026-10-18') })];
    const next = computeDrivingLicenseState(rows, bkk('2026-10-19', '00:00'));
    expect(next).toMatchObject({ verified: false, status: 'approved', isExpired: true });
  });

  it('ใช้ปฏิทินไทย ไม่ใช่ UTC: 17:30Z ของวันที่ 18 = 00:30 ไทยวันที่ 19 -> หมดอายุแล้ว', () => {
    const rows = [row({ expiresAt: endOfDay('2026-10-18') })];
    expect(computeDrivingLicenseState(rows, new Date('2026-10-18T17:30:00Z')).verified).toBe(false);
    expect(computeDrivingLicenseState(rows, new Date('2026-10-18T16:30:00Z')).verified).toBe(true);
  });

  it('ไม่ขึ้นกับเวลาที่เก็บในคอลัมน์: expires_at เก็บเป็นเที่ยงคืนต้นวันก็ยังนับทั้งวัน', () => {
    const rows = [row({ expiresAt: bkk('2026-10-18', '00:00') })];
    expect(computeDrivingLicenseState(rows, bkk('2026-10-18', '15:00')).verified).toBe(true);
  });

  it('approved แต่ไม่มีวันหมดอายุ -> ไม่ผ่าน (ต้องมีวันหมดอายุเสมอ AC3)', () => {
    expect(computeDrivingLicenseState([row({ expiresAt: null })], NOW).verified).toBe(false);
  });

  it('คำนวณใหม่ทุกครั้งที่เรียกจาก now ที่ส่งมา (R9: ไม่เก็บสถานะ)', () => {
    const rows = [row({ expiresAt: endOfDay('2026-10-20') })];
    expect(computeDrivingLicenseState(rows, bkk('2026-10-20', '12:00')).verified).toBe(true);
    expect(computeDrivingLicenseState(rows, bkk('2026-10-21', '12:00')).verified).toBe(false);
  });

  describe('หลายแถว (E7, E8)', () => {
    it('E7: ใบเดิมถูกปฏิเสธ ใบใหม่รอตรวจ -> แสดงผลตามใบล่าสุด (pending) ไม่ผ่าน', () => {
      const s = computeDrivingLicenseState(
        [
          row({ id: 'old', reviewStatus: 'rejected', uploadedAt: new Date('2026-09-01') }),
          row({ id: 'new', reviewStatus: 'pending', uploadedAt: new Date('2026-10-10') }),
        ],
        NOW,
      );
      expect(s).toMatchObject({ verified: false, status: 'pending', documentId: 'new' });
    });

    it('ใบล่าสุดถูกปฏิเสธ -> status rejected แสดงตามใบล่าสุด', () => {
      const s = computeDrivingLicenseState(
        [
          row({ id: 'old', reviewStatus: 'rejected', uploadedAt: new Date('2026-09-01') }),
          row({ id: 'new', reviewStatus: 'rejected', uploadedAt: new Date('2026-10-10') }),
        ],
        NOW,
      );
      expect(s).toMatchObject({ status: 'rejected', documentId: 'new' });
    });

    it('E8: ต่ออายุ — ใบเดิมอนุมัติและยังไม่หมดอายุยังทำให้ผ่านระหว่างรอตรวจใบใหม่', () => {
      const s = computeDrivingLicenseState(
        [
          row({ id: 'old', reviewStatus: 'approved', uploadedAt: new Date('2026-01-01') }),
          row({ id: 'renew', reviewStatus: 'pending', uploadedAt: new Date('2026-10-10') }),
        ],
        NOW,
      );
      expect(s).toMatchObject({ verified: true, status: 'pending', documentId: 'renew' });
    });

    it('ใบเดิมอนุมัติแต่หมดอายุ + ใบใหม่รอตรวจ -> ไม่ผ่าน', () => {
      const s = computeDrivingLicenseState(
        [
          row({ id: 'old', expiresAt: endOfDay('2026-10-01'), uploadedAt: new Date('2025-10-01') }),
          row({ id: 'renew', reviewStatus: 'pending', uploadedAt: new Date('2026-10-10') }),
        ],
        NOW,
      );
      expect(s.verified).toBe(false);
    });

    it('ใบล่าสุดอนุมัติหมดอายุ + ใบเก่ายังไม่หมดอายุ (ผิดปกติ) -> ยังผ่านด้วยใบที่ใช้ได้ แต่ isExpired ตามใบล่าสุด', () => {
      const s = computeDrivingLicenseState(
        [
          row({ id: 'a', expiresAt: endOfDay('2026-12-31'), uploadedAt: new Date('2026-01-01') }),
          row({ id: 'b', expiresAt: endOfDay('2026-10-01'), uploadedAt: new Date('2026-09-01') }),
        ],
        NOW,
      );
      expect(s).toMatchObject({ verified: true, documentId: 'b', isExpired: true });
    });
  });
});
