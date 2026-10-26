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
 * ★ จองได้ทั้งวัน (feature/booking-24h, 2026-10-26): เดิม 06:00–22:00 นอกนั้นไม่มี slot
 *   ตอนนี้ขยายช่วงหัวท้ายให้ครอบ 24 ชม. โดยไม่เพิ่มค่าใน enum time_slot (ไม่ต้อง migrate)
 *   · morning 06:00 → 00:00 (เช้ามืด 00:00–06:00 นับเป็นช่วงเช้า)
 *   · evening 22:00 → 24:00 (ดึก 22:00–24:00 นับเป็นช่วงเย็น)
 *   ผู้ดูแลที่เปิดรับ "เช้า"/"เย็น" ไว้แล้วจะได้คำขอช่วงนี้ด้วย (ยังกดรับ/ปฏิเสธเองได้)
 *   FE แก้ข้อความใน JobReceptionTab เป็น 00:00–12:00 / 17:00–24:00 พร้อมกัน
 *
 * ช่วงเป็นแบบ [start, end) หน่วยนาทีนับจากเที่ยงคืน — 12:00 เป็นของ afternoon ไม่ใช่ morning
 * ครบ 00:00–24:00 → ทุกเวลาเริ่มมี slot · ทุกงานที่ยาว > 0 คาบเกี่ยวอย่างน้อย 1 slot
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
  morning: { startMinute: 0, endMinute: 12 * 60 },
  afternoon: { startMinute: 12 * 60, endMinute: 17 * 60 },
  evening: { startMinute: 17 * 60, endMinute: 24 * 60 },
};

/** เวลาเริ่มที่เร็วที่สุด / ช้าที่สุด (ไม่รวม) ที่มี slot รองรับ */
export const SERVICE_DAY_START_MINUTE = TIME_SLOT_RANGES.morning.startMinute;
export const SERVICE_DAY_END_MINUTE = TIME_SLOT_RANGES.evening.endMinute;

/**
 * slot ที่เวลาเริ่มตกอยู่ — ใช้เก็บลง bookings.time_slot ให้ข้อมูล/การแสดงผลเดิมใช้ต่อได้
 * คืน null ถ้าอยู่นอกทุกช่วง — ตอนนี้ครบ 24 ชม. แล้ว เหลือแค่ค่าผิดรูป (ติดลบ / ≥ 24:00)
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
