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
  it('ตัวเลขตรงกับที่ FE แสดง (BookingStepDateTime / JobReceptionTab): 06–12 / 12–17 / 17–22', () => {
    // ★ ถ้าเทสนี้แดงเพราะตั้งใจเปลี่ยนช่วง ต้องแก้ข้อความสองหน้านั้นใน FE ด้วย
    //   ไม่งั้นผู้ดูแลจะได้งานนอกช่วงที่ตัวเองติ๊กไว้
    expect(TIME_SLOT_RANGES).toEqual({
      morning: { startMinute: at('06:00'), endMinute: at('12:00') },
      afternoon: { startMinute: at('12:00'), endMinute: at('17:00') },
      evening: { startMinute: at('17:00'), endMinute: at('22:00') },
    });
  });

  describe('inferTimeSlot — ขอบของแต่ละช่วง', () => {
    it.each([
      ['05:59', null],
      ['06:00', 'morning'],
      ['11:59', 'morning'],
      ['12:00', 'afternoon'],
      ['16:59', 'afternoon'],
      ['17:00', 'evening'],
      ['21:59', 'evening'],
      ['22:00', null],
      ['23:30', null],
      ['00:00', null],
    ])('%s → %s', (time, expected) => {
      expect(inferTimeSlot(at(time))).toBe(expected);
    });
  });

  describe('overlappingSlots — ทุกช่วงที่งานกินเวลาไปถึง', () => {
    it.each([
      ['10:00', '15:00', ['morning', 'afternoon']],
      ['09:00', '12:00', ['morning']], // จบ 12:00 พอดี = แค่แตะขอบ ไม่นับบ่าย
      ['11:30', '12:30', ['morning', 'afternoon']],
      ['06:00', '22:00', ['morning', 'afternoon', 'evening']],
      ['20:00', '23:30', ['evening']], // ส่วนหลัง 22:00 ไม่มี slot รองรับ
      ['04:00', '06:00', []],
    ])('%s–%s → %j', (start, end, expected) => {
      expect(overlappingSlots(at(start), at(end))).toEqual(expected);
    });
  });
});
