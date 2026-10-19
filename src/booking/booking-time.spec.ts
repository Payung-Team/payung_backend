import { BadRequestException } from '@nestjs/common';
import { resolveBookingTime } from './booking-time';

/** เรียกแล้วคืนข้อความ error — ให้เคสอ่านง่ายว่า "ปฏิเสธด้วยข้อความอะไร" */
function rejectMessage(
  input: Parameters<typeof resolveBookingTime>[0],
): string {
  try {
    resolveBookingTime(input);
  } catch (err) {
    expect(err).toBeInstanceOf(BadRequestException);
    return (err as BadRequestException).message;
  }
  throw new Error('expected resolveBookingTime to throw');
}

describe('resolveBookingTime (PYG-523)', () => {
  describe('แบบใหม่: startTime + endTime', () => {
    it('คำนวณ durationHours + timeSlot เอง', () => {
      expect(
        resolveBookingTime({ startTime: '09:00', endTime: '13:30' }),
      ).toEqual({
        timeSlot: 'morning',
        startTime: '09:00:00',
        startMinute: 9 * 60,
        durationHours: 4.5,
      });
    });

    it('timeSlot มาจากเวลาเริ่ม แม้งานจะยาวข้ามไปช่วงถัดไป', () => {
      expect(
        resolveBookingTime({ startTime: '11:00', endTime: '15:00' }).timeSlot,
      ).toBe('morning');
      expect(
        resolveBookingTime({ startTime: '12:00', endTime: '14:00' }).timeSlot,
      ).toBe('afternoon');
      expect(
        resolveBookingTime({ startTime: '17:00', endTime: '19:00' }).timeSlot,
      ).toBe('evening');
    });

    it('ทิ้ง timeSlot / durationHours ที่ client ส่งมาด้วย — ใช้ค่าที่คำนวณเองเสมอ', () => {
      // ★ กันเคส FE ส่งค่าเก่าค้างมาพร้อม endTime แล้วราคา/ตารางงานผิด
      const result = resolveBookingTime({
        startTime: '13:00',
        endTime: '15:00',
        timeSlot: 'morning',
        durationHours: 8,
      });
      expect(result.timeSlot).toBe('afternoon');
      expect(result.durationHours).toBe(2);
    });

    it('รับ "HH:mm:00" ด้วย (FE เดิมส่งมีวินาที)', () => {
      expect(
        resolveBookingTime({ startTime: '09:00:00', endTime: '10:00:00' })
          .durationHours,
      ).toBe(1);
    });

    it.each([
      ['1 ชม. พอดี', '06:00', '07:00', 1],
      ['12 ชม. พอดี', '06:00', '18:00', 12],
      ['เริ่มช้าสุด 21:30', '21:30', '23:30', 2],
    ])('ขอบที่รับได้: %s', (_label, startTime, endTime, hours) => {
      expect(resolveBookingTime({ startTime, endTime }).durationHours).toBe(
        hours,
      );
    });

    it.each([
      ['25:99', '10:00', 'รูปแบบเวลาเริ่มไม่ถูกต้อง'],
      ['9:00', '10:00', 'รูปแบบเวลาเริ่มไม่ถูกต้อง'],
      ['', '10:00', 'รูปแบบเวลาเริ่มไม่ถูกต้อง'],
      ['09:00', '24:00', 'รูปแบบเวลาสิ้นสุดไม่ถูกต้อง'],
      ['09:00', 'abc', 'รูปแบบเวลาสิ้นสุดไม่ถูกต้อง'],
    ])('รูปแบบผิด: %s–%s', (startTime, endTime, message) => {
      expect(rejectMessage({ startTime, endTime })).toContain(message);
    });

    it.each([
      ['09:15', '11:00'],
      ['09:00', '10:45'],
      ['09:00:30', '11:00'],
    ])('ไม่ลงขั้น 30 นาที: %s–%s', (startTime, endTime) => {
      expect(rejectMessage({ startTime, endTime })).toBe(
        'เวลาเริ่มและเวลาสิ้นสุดต้องลงที่ :00 หรือ :30 เท่านั้น',
      );
    });

    it('เวลาสิ้นสุดเท่ากับเวลาเริ่ม → ปฏิเสธ', () => {
      expect(rejectMessage({ startTime: '10:00', endTime: '10:00' })).toBe(
        'เวลาสิ้นสุดต้องหลังเวลาเริ่ม และอยู่ในวันเดียวกัน',
      );
    });

    it('เวลาสิ้นสุดก่อนเวลาเริ่ม / ข้ามเที่ยงคืน → ปฏิเสธ', () => {
      expect(rejectMessage({ startTime: '14:00', endTime: '10:00' })).toBe(
        'เวลาสิ้นสุดต้องหลังเวลาเริ่ม และอยู่ในวันเดียวกัน',
      );
      expect(rejectMessage({ startTime: '20:00', endTime: '02:00' })).toBe(
        'เวลาสิ้นสุดต้องหลังเวลาเริ่ม และอยู่ในวันเดียวกัน',
      );
    });

    it('สั้นกว่า 1 ชม. → ปฏิเสธ', () => {
      expect(rejectMessage({ startTime: '09:00', endTime: '09:30' })).toBe(
        'ต้องจองอย่างน้อย 1 ชั่วโมง',
      );
    });

    it('ยาวกว่า 12 ชม. → ปฏิเสธ', () => {
      expect(rejectMessage({ startTime: '06:00', endTime: '18:30' })).toBe(
        'จองได้สูงสุด 12 ชั่วโมงต่อครั้ง',
      );
    });

    it.each([
      ['05:30', '07:00'],
      ['22:00', '23:30'],
    ])('เวลาเริ่มนอก 06:00–21:30 → ปฏิเสธ: %s', (startTime, endTime) => {
      expect(rejectMessage({ startTime, endTime })).toBe(
        'เวลาเริ่มต้องอยู่ระหว่าง 06:00 ถึง 21:30',
      );
    });
  });

  describe('แบบเดิม (ช่วงเปลี่ยนผ่าน): timeSlot + durationHours', () => {
    it('FE เดิมยังจองได้ — ใช้ค่าที่ส่งมาตรง ๆ', () => {
      expect(
        resolveBookingTime({
          startTime: '09:00:00',
          timeSlot: 'morning',
          durationHours: 4,
        }),
      ).toEqual({
        timeSlot: 'morning',
        startTime: '09:00:00',
        startMinute: 9 * 60,
        durationHours: 4,
      });
    });

    it('ไม่เพิ่มกฎใหม่ให้แบบเดิม — เวลาไม่ลงขั้น 30 นาทีก็ยังรับ (มีใบจองจริงแบบนี้อยู่)', () => {
      expect(
        resolveBookingTime({
          startTime: '21:58',
          timeSlot: 'evening',
          durationHours: 2,
        }).startTime,
      ).toBe('21:58:00');
    });

    it('แต่รูปแบบเวลาเริ่มต้องถูก — เดิม "25:99" หลุดไปถึง new Date()', () => {
      expect(
        rejectMessage({
          startTime: '25:99',
          timeSlot: 'morning',
          durationHours: 4,
        }),
      ).toContain('รูปแบบเวลาเริ่มไม่ถูกต้อง');
    });

    it.each([
      [{ startTime: '09:00' }],
      [{ startTime: '09:00', timeSlot: 'morning' }],
      [{ startTime: '09:00', durationHours: 4 }],
      [{ startTime: '09:00', timeSlot: 'night', durationHours: 4 }],
      [{ startTime: '09:00', timeSlot: 'morning', durationHours: 0.25 }],
    ])('ขาด endTime และข้อมูลแบบเดิมไม่ครบ/ผิด → ปฏิเสธ: %j', (input) => {
      expect(rejectMessage(input)).toBe('กรุณาระบุเวลาสิ้นสุด');
    });
  });
});
