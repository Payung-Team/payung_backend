/**
 * recordBookingStatusChange — ตัวเขียน booking_status_history ตัวเดียวของระบบ (PYG-461/462)
 *
 * append-only: ฟังก์ชันนี้ทำได้แค่ INSERT — ไม่มีทางแก้/ลบแถวเก่าจากโค้ดแอป
 *
 * ★ บังคับรับ tx (ไม่ใช่ optional) โดยตั้งใจ — แนวเดียวกับ JobQrService.createForBooking
 *   history ต้องเกิดใน transaction เดียวกับ UPDATE bookings.status เสมอ
 *   ถ้าเขียนแยก tx จะเกิดสภาพ "status เปลี่ยนแล้วแต่ไม่มี audit" หรือกลับกันได้
 *
 * ขอบเขตผู้เรียก (มติ 2026-09-11): cron หมดอายุ booking + BookingSettlementService เท่านั้น
 * call site เดิมที่เปลี่ยน bookings.status อยู่แล้ว ห้าม retrofit ใน PR นี้ — เป็นการ์ดแยก
 */
import type { Prisma } from '@prisma/client';

export type BookingStatusChange = {
  bookingId: string;
  /** สถานะก่อนเปลี่ยน — null ได้ถ้าไม่รู้ (ปกติผู้เรียกรู้เสมอเพราะอ่านมาใต้ lock) */
  fromStatus: string | null;
  toStatus: string;
  /** users.id ของคนสั่ง — ไม่ใส่/null = ระบบหรือ cron */
  changedBy?: string | null;
  /** สาเหตุย่อย เช่น 'expired_no_accept' / 'patient_cancel' */
  reason?: string;
  metadata?: Record<string, unknown>;
};

export async function recordBookingStatusChange(
  tx: Prisma.TransactionClient,
  change: BookingStatusChange,
): Promise<void> {
  await tx.bookingStatusHistory.create({
    data: {
      bookingId: change.bookingId,
      fromStatus: change.fromStatus,
      toStatus: change.toStatus,
      changedBy: change.changedBy ?? null,
      reason: change.reason,
      metadata:
        change.metadata === undefined
          ? undefined
          : (change.metadata as Prisma.InputJsonValue),
    },
  });
}
