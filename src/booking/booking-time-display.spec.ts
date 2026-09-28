import { Prisma } from '@prisma/client';
import {
  computeEndTime,
  formatBookingTimeRange,
  formatDurationHours,
  formatStartTime,
} from './booking-time-display';

/** start_time จาก Prisma: คอลัมน์ TIME → Date ฐาน 1970-01-01 UTC */
function time(h: number, m = 0): Date {
  return new Date(Date.UTC(1970, 0, 1, h, m, 0));
}

describe('booking-time-display (PYG-526)', () => {
  describe('formatStartTime', () => {
    it('อ่านส่วน UTC ของ Date → "HH:mm"', () => {
      expect(formatStartTime(time(9))).toBe('09:00');
      expect(formatStartTime(time(21, 30))).toBe('21:30');
    });

    it('ไม่มีค่า / Date ไม่ถูกต้อง → undefined', () => {
      expect(formatStartTime(null)).toBeUndefined();
      expect(formatStartTime(undefined)).toBeUndefined();
      expect(formatStartTime(new Date('invalid'))).toBeUndefined();
    });
  });

  describe('computeEndTime', () => {
    it('เริ่ม + ชั่วโมงเต็ม', () => {
      expect(computeEndTime(time(9), 4)).toBe('13:00');
    });

    it('รองรับครึ่งชั่วโมงและ Prisma.Decimal', () => {
      expect(computeEndTime(time(8, 30), new Prisma.Decimal('1.5'))).toBe('10:00');
    });

    it('ใบจองเก่าที่ข้ามเที่ยงคืน → วนรอบเป็นเวลาของวันถัดไป ไม่ใช่ "25:58"', () => {
      expect(computeEndTime(time(21, 58), 4)).toBe('01:58');
    });

    it('ชั่วโมง ≤ 0 / null / ไม่มีเวลาเริ่ม → undefined (ไม่เดาเวลาสิ้นสุด)', () => {
      expect(computeEndTime(time(9), 0)).toBeUndefined();
      expect(computeEndTime(time(9), null)).toBeUndefined();
      expect(computeEndTime(time(9), Number.NaN)).toBeUndefined();
      expect(computeEndTime(null, 4)).toBeUndefined();
    });
  });

  describe('formatDurationHours', () => {
    it('จำนวนเต็มไม่มีทศนิยม, เศษแสดงตามจริง', () => {
      expect(formatDurationHours(4)).toBe('4 ชม.');
      expect(formatDurationHours(new Prisma.Decimal('4.5'))).toBe('4.5 ชม.');
    });

    it('ปัด 2 ตำแหน่งกันเลขลอยจากใบจองเก่า', () => {
      expect(formatDurationHours(4 / 3)).toBe('1.33 ชม.');
    });

    it('ค่าไม่ถูกต้อง → undefined', () => {
      expect(formatDurationHours(0)).toBeUndefined();
      expect(formatDurationHours(null)).toBeUndefined();
    });
  });

  describe('formatBookingTimeRange', () => {
    it('รูปแบบตามการ์ด: "09:00 – 13:00 (4 ชม.)"', () => {
      expect(formatBookingTimeRange(time(9), 4)).toBe('09:00 – 13:00 (4 ชม.)');
    });

    it('จอง 11:00–15:00 ได้เวลาจริง ไม่ใช่ชื่อ slot "ช่วงเช้า"', () => {
      expect(formatBookingTimeRange(time(11), 4)).toBe('11:00 – 15:00 (4 ชม.)');
    });

    it('ชั่วโมงไม่ถูกต้อง → แสดงแค่เวลาเริ่ม', () => {
      expect(formatBookingTimeRange(time(9), null)).toBe('09:00');
    });

    it('ไม่มีเวลาเริ่ม → undefined', () => {
      expect(formatBookingTimeRange(null, 4)).toBeUndefined();
    });
  });
});
