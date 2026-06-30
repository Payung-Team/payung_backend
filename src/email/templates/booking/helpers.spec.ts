/**
 * Unit tests สำหรับ booking email template helpers (PYG-293)
 * - formatThaiDate / formatTimeSlot / formatRating / formatPriceBreakdown
 * - greeting + escape behaviour (กัน XSS)
 */
import {
  formatBaht,
  formatPriceBreakdown,
  formatRating,
  formatServiceType,
  formatThaiDate,
  formatTimeSlot,
  greeting,
} from './helpers';

describe('booking template helpers', () => {
  describe('formatThaiDate', () => {
    it('แปลง Date เป็น "วัน เดือนเต็ม พ.ศ."', () => {
      // 15 ก.ค. 2026 (ค.ศ.) → 15 กรกฎาคม 2569 (พ.ศ.)
      const d = new Date(Date.UTC(2026, 6, 15));
      expect(formatThaiDate(d)).toBe('15 กรกฎาคม 2569');
    });

    it('ใช้ UTC components (ไม่ตามเขตเวลาเครื่อง)', () => {
      const d = new Date(Date.UTC(2026, 0, 1));
      expect(formatThaiDate(d)).toBe('1 มกราคม 2569');
    });
  });

  describe('formatTimeSlot', () => {
    it('คำนวณ end time จาก startTime + durationHours', () => {
      const start = new Date(Date.UTC(1970, 0, 1, 9, 0, 0)); // 09:00 UTC
      expect(formatTimeSlot(start, 4)).toBe('09:00 - 13:00 น. (4 ชม.)');
    });

    it('รองรับครึ่งชั่วโมง (Decimal-ish)', () => {
      const start = new Date(Date.UTC(1970, 0, 1, 8, 30, 0));
      expect(formatTimeSlot(start, 1.5)).toBe('08:30 - 10:00 น. (1.5 ชม.)');
    });

    it('คืน "-" ถ้า startTime null', () => {
      expect(formatTimeSlot(null, 4)).toBe('-');
    });

    it('แสดงเฉพาะ start ถ้า duration ไม่ valid', () => {
      const start = new Date(Date.UTC(1970, 0, 1, 9, 0, 0));
      expect(formatTimeSlot(start, null)).toBe('09:00 น.');
    });
  });

  describe('formatRating', () => {
    it('แสดงคะแนน + จำนวนรีวิว', () => {
      expect(formatRating(4.8, 12)).toBe('4.8 ★ (รีวิว 12 ครั้ง)');
    });

    it('คืน "ยังไม่มีรีวิว" ถ้า avg=null หรือ count=0', () => {
      expect(formatRating(null, 0)).toBe('ยังไม่มีรีวิว');
      expect(formatRating(4.5, 0)).toBe('ยังไม่มีรีวิว');
      expect(formatRating(null, 5)).toBe('ยังไม่มีรีวิว');
    });
  });

  describe('formatPriceBreakdown', () => {
    it('ใช้ค่า platformFee ที่ส่งมาถ้ามี', () => {
      expect(formatPriceBreakdown(1000, 100)).toEqual({
        serviceCostText: '฿1,000',
        platformFeeText: '฿100',
        totalText: '฿1,100',
      });
    });

    it('คำนวณ 10% ถ้า platformFee เป็น null', () => {
      expect(formatPriceBreakdown(2000, null)).toEqual({
        serviceCostText: '฿2,000',
        platformFeeText: '฿200',
        totalText: '฿2,200',
      });
    });

    it('คืน "-" ถ้า estimatedCost null', () => {
      const r = formatPriceBreakdown(null, null);
      expect(r.serviceCostText).toBe('-');
      expect(r.totalText).toBe('-');
    });
  });

  describe('formatBaht', () => {
    it('รองรับ Prisma.Decimal-like (toNumber)', () => {
      const decimal = { toNumber: () => 1234.5 };
      expect(formatBaht(decimal as never)).toBe('฿1,234.5');
    });

    it('คืน "-" ถ้า null/undefined', () => {
      expect(formatBaht(null)).toBe('-');
      expect(formatBaht(undefined)).toBe('-');
    });
  });

  describe('formatServiceType', () => {
    it('แปลง enum → ป้ายไทย', () => {
      expect(formatServiceType('general_care')).toBe('ดูแลทั่วไป');
      expect(formatServiceType('bedridden_care')).toBe('ดูแลผู้ป่วยติดเตียง');
    });

    it('คืน raw value ถ้าไม่ใน map (กัน enum ใหม่)', () => {
      expect(formatServiceType('unknown_service')).toBe('unknown_service');
    });
  });

  describe('greeting (XSS guard)', () => {
    it('escape ชื่อที่มี HTML tag', () => {
      const out = greeting('<script>alert(1)</script>');
      expect(out).toBe('สวัสดีค่ะ คุณ&lt;script&gt;alert(1)&lt;/script&gt;');
      expect(out).not.toContain('<script>');
    });

    it('escape quote ในชื่อ', () => {
      expect(greeting(`O'Brien`)).toBe('สวัสดีค่ะ คุณO&#39;Brien');
    });

    it('คืน fallback ถ้า name = null', () => {
      expect(greeting(null)).toBe('สวัสดีค่ะ คุณผู้ใช้');
    });
  });
});
