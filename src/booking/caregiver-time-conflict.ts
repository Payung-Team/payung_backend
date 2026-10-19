/**
 * เช็คเวลาชน "ต่อผู้ดูแล" — PYG-544
 *
 * ใช้ 2 ที่ด้วยเกณฑ์เดียวกัน (ห้ามก๊อปเงื่อนไขไปเขียนเองที่อื่น):
 *   - createBookingRecord (booking.service.ts)           — จองผู้ดูแลในเวลาที่เขารับงานไว้แล้ว → 409
 *   - acceptBooking       (caregiver-booking.service.ts) — กดรับงานที่ซ้อนกับงานที่รับไว้แล้ว → 409
 *
 * ของเดิม: ฝั่งจองเช็คเวลาชนแค่ต่อผู้รับบริการ (PYG-424) + ตารางว่างรายสัปดาห์ (PYG-524)
 * ฝั่งรับงานเช็คแค่ status 'confirmed' → ผู้ดูแลรับงานซ้อนกันได้ทั้งสองใบ
 */
import type { Prisma } from '@prisma/client';

/**
 * สถานะที่ถือว่า "ผู้ดูแลรับงานนี้ไว้แล้ว" = ต้องไปทำจริง
 *
 * ★ ไม่นับ 'pending' โดยตั้งใจ — ผู้ดูแลยังไม่ได้ตอบ อาจปฏิเสธใบแรกก็ได้
 *   ถ้านับ ผู้จองคนที่สองจะถูกตัดโอกาสเพราะใบที่อาจไม่เกิดขึ้นจริง
 *   ใบ pending ที่ซ้อนกันหลายใบจะถูกคัดตอนกดรับ: รับได้ใบเดียว ใบที่เหลือรับไม่ได้
 */
export const CAREGIVER_BUSY_STATUSES = ['accepted', 'confirmed', 'in_progress'];

export interface CaregiverTimeRange {
  caregiverId: string;
  /** booking_date (คอลัมน์ DATE) */
  bookingDate: Date;
  /** นาทีนับจากเที่ยงคืนของวันจอง */
  startMinute: number;
  endMinute: number;
  /** ใบที่กำลังจะรับ — ไม่นับตัวเอง */
  excludeBookingId?: string;
}

/**
 * ผู้ดูแลมีงานที่รับไว้แล้วซ้อนกับช่วงเวลานี้หรือไม่
 * ต่อกันพอดี (จบ = เริ่ม) ไม่นับว่าชน — เกณฑ์เดียวกับเช็คเวลาชนต่อผู้รับบริการ
 */
export async function caregiverHasTimeConflict(
  db: Pick<Prisma.TransactionClient, 'booking'>,
  range: CaregiverTimeRange,
): Promise<boolean> {
  const busy = await db.booking.findMany({
    where: {
      caregiverId: range.caregiverId,
      bookingDate: range.bookingDate,
      status: { in: CAREGIVER_BUSY_STATUSES },
      ...(range.excludeBookingId
        ? { id: { not: range.excludeBookingId } }
        : {}),
    },
    select: { startTime: true, durationHours: true },
  });

  return busy.some((b) => {
    const existStart =
      b.startTime.getUTCHours() * 60 + b.startTime.getUTCMinutes();
    const existEnd = existStart + Math.round(Number(b.durationHours) * 60);
    return range.startMinute < existEnd && existStart < range.endMinute;
  });
}

/**
 * ล็อกแถวผู้ดูแลจนจบ transaction — การกดรับงานของผู้ดูแลคนเดียวกันจะต่อคิวกัน
 *
 * ต้องเรียกก่อน caregiverHasTimeConflict ใน transaction เดียวกับการเปลี่ยนสถานะ
 * ไม่งั้นกดรับ 2 ใบที่ซ้อนกันพร้อมกัน ต่างฝ่ายต่างเช็คแล้วไม่เห็นกัน → ผ่านทั้งคู่
 * (conditional update WHERE status='pending' ของ PYG-461/462 กันได้แค่ใบเดียวกัน ไม่กันคนละใบ)
 */
export async function lockCaregiverSchedule(
  tx: Pick<Prisma.TransactionClient, '$queryRaw'>,
  caregiverId: string,
): Promise<void> {
  await tx.$queryRaw`SELECT 1 FROM "caregivers" WHERE "id" = ${caregiverId} FOR UPDATE`;
}
