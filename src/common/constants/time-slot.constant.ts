/**
 * ขอบเขตเวลาของแต่ละ timeSlot — PYG-522 (ที่เดียวในระบบ)
 *
 * ★ ทำไมต้องมีไฟล์นี้
 *   enum time_slot ใน DB มีแค่ชื่อ (morning / afternoon / evening) ไม่เคยมีที่ไหนใน BE
 *   บอกว่าแต่ละช่วงคือกี่โมง — client เป็นคนเลือก slot ส่งมาเองทั้งหมด
 *   PYG-490 ให้ BE อนุมาน slot จากเวลาเริ่มเอง จึงต้องมีนิยามกลางที่ทุกที่ใช้ร่วมกัน
 *   (booking, ตารางเวลาว่างผู้ดูแล work_conditions, ปฏิทินหน้าโปรไฟล์ PYG-493)
 *   ถ้าแต่ละที่ตั้งตัวเลขเอง วันหนึ่งผู้ดูแลที่ติ๊ก "เย็น" จะได้งานนอกช่วงที่ตัวเองเข้าใจ
 *
 * ★ ตัวเลขตาม FE ปัจจุบัน ไม่ใช่ข้อเสนอเดิมของการ์ด (06–12 / 12–18 / 18–24)
 *   มติ 2026-09-25: ใช้ช่วงที่ผู้ใช้เห็นอยู่แล้วในฟอร์มจอง (BookingStepDateTime) และ
 *   หน้าตั้งเวลารับงานของผู้ดูแล (JobReceptionTab) — ผู้ดูแลติ๊กตารางว่างตามข้อความนั้นไปแล้ว
 *   ถ้าจะเปลี่ยนตัวเลข ต้องแก้ข้อความสองหน้านั้นพร้อมกัน
 *
 * ช่วงเป็นแบบ [start, end) หน่วยนาทีนับจากเที่ยงคืน — 12:00 เป็นของ afternoon ไม่ใช่ morning
 * นอก 06:00–22:00 ไม่มี slot → ไม่รับจอง
 */

export const TIME_SLOTS = ['morning', 'afternoon', 'evening'] as const;
export type TimeSlot = (typeof TIME_SLOTS)[number];

export interface TimeSlotRange {
  /** นาทีนับจากเที่ยงคืน (รวม) */
  startMinute: number;
  /** นาทีนับจากเที่ยงคืน (ไม่รวม) */
  endMinute: number;
}

export const TIME_SLOT_RANGES: Readonly<Record<TimeSlot, TimeSlotRange>> = {
  morning: { startMinute: 6 * 60, endMinute: 12 * 60 },
  afternoon: { startMinute: 12 * 60, endMinute: 17 * 60 },
  evening: { startMinute: 17 * 60, endMinute: 22 * 60 },
};

/** เวลาเริ่มที่เร็วที่สุด / ช้าที่สุด (ไม่รวม) ที่มี slot รองรับ */
export const SERVICE_DAY_START_MINUTE = TIME_SLOT_RANGES.morning.startMinute;
export const SERVICE_DAY_END_MINUTE = TIME_SLOT_RANGES.evening.endMinute;

/**
 * slot ที่เวลาเริ่มตกอยู่ — ใช้เก็บลง bookings.time_slot ให้ข้อมูล/การแสดงผลเดิมใช้ต่อได้
 * คืน null ถ้าอยู่นอกทุกช่วง (ก่อน 06:00 หรือตั้งแต่ 22:00)
 */
export function inferTimeSlot(startMinute: number): TimeSlot | null {
  for (const slot of TIME_SLOTS) {
    const { startMinute: from, endMinute: to } = TIME_SLOT_RANGES[slot];
    if (startMinute >= from && startMinute < to) return slot;
  }
  return null;
}

/**
 * ทุก slot ที่ช่วง [startMinute, endMinute) คาบเกี่ยว — เช่น 10:00–15:00 → morning + afternoon
 * ใช้กับการเช็คผู้ดูแลว่าง (PYG-524): ต้องว่างครบทุก slot ที่งานกินเวลาไปถึง
 * ช่วงที่แค่แตะขอบ (จบ 12:00 พอดี) ไม่นับ slot ถัดไป
 */
export function overlappingSlots(
  startMinute: number,
  endMinute: number,
): TimeSlot[] {
  return TIME_SLOTS.filter((slot) => {
    const { startMinute: from, endMinute: to } = TIME_SLOT_RANGES[slot];
    return startMinute < to && from < endMinute;
  });
}
