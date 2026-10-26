import {
  TIME_SLOT_RANGES,
  inferTimeSlot,
  overlappingSlots,
} from './time-slot.constant';

/** "HH:mm" → นาทีนับจากเที่ยงคืน — ให้เคสทดสอบอ่านเป็นเวลาได้ตรง ๆ */
const at = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

describe('time-slot constants (PYG-522)', () => {
  it('ตัวเลขตรงกับที่ FE แสดง (JobReceptionTab): 00–12 / 12–17 / 17–24', () => {
    // ★ ถ้าเทสนี้แดงเพราะตั้งใจเปลี่ยนช่วง ต้องแก้ข้อความหน้าตั้งเวลารับงานใน FE ด้วย
    //   ไม่งั้นผู้ดูแลจะได้งานนอกช่วงที่ตัวเองติ๊กไว้
    //   feature/booking-24h: ขยายเช้า 06:00 → 00:00 และเย็น 22:00 → 24:00 ให้จองได้ทั้งวัน
    expect(TIME_SLOT_RANGES).toEqual({
      morning: { startMinute: at('00:00'), endMinute: at('12:00') },
      afternoon: { startMinute: at('12:00'), endMinute: at('17:00') },
      evening: { startMinute: at('17:00'), endMinute: 24 * 60 },
    });
  });

  describe('inferTimeSlot — ขอบของแต่ละช่วง', () => {
    it.each([
      ['00:00', 'morning'],
      ['05:59', 'morning'],
      ['06:00', 'morning'],
      ['11:59', 'morning'],
      ['12:00', 'afternoon'],
      ['16:59', 'afternoon'],
      ['17:00', 'evening'],
      ['21:59', 'evening'],
      ['22:00', 'evening'],
      ['23:30', 'evening'],
      ['23:59', 'evening'],
    ])('%s → %s', (time, expected) => {
      expect(inferTimeSlot(at(time))).toBe(expected);
    });

    it('นอก 00:00–24:00 (ค่าผิดรูป) → null', () => {
      expect(inferTimeSlot(-1)).toBeNull();
      expect(inferTimeSlot(24 * 60)).toBeNull();
    });
  });

  describe('overlappingSlots — ทุกช่วงที่งานกินเวลาไปถึง', () => {
    it.each([
      ['10:00', '15:00', ['morning', 'afternoon']],
      ['09:00', '12:00', ['morning']], // จบ 12:00 พอดี = แค่แตะขอบ ไม่นับบ่าย
      ['11:30', '12:30', ['morning', 'afternoon']],
      ['06:00', '22:00', ['morning', 'afternoon', 'evening']],
      ['20:00', '23:30', ['evening']],
      ['04:00', '06:00', ['morning']],
    ])('%s–%s → %j', (start, end, expected) => {
      expect(overlappingSlots(at(start), at(end))).toEqual(expected);
    });

    it.each([
      // ★ เดิมงานพวกนี้ได้ [] → การจองระบุตัวผู้ดูแลข้ามด่านตารางว่าง ([].every = true)
      //   ส่วน matching ปฏิเสธทุกคน (!required.length) — ตอนนี้ต้องได้อย่างน้อย 1 ช่วงเสมอ
      ['22:00', '24:00', ['evening']], // จบ "23:59" = 24:00
      ['23:00', '24:00', ['evening']],
      ['00:00', '03:00', ['morning']],
      ['12:00', '24:00', ['afternoon', 'evening']],
    ])('ช่วงดึก / เช้ามืด %s–%s → %j', (start, end, expected) => {
      expect(overlappingSlots(at(start), at(end))).toEqual(expected);
    });
  });
});
