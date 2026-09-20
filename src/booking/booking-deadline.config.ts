/**
 * กำหนดเวลา (deadline) ของ booking ก่อนเริ่มงาน — PYG-461/462 เฟส 1
 *
 * ใช้ 3 ที่ด้วยสูตรเดียวกัน (ห้ามก๊อปสูตรไปคำนวณเองที่อื่น):
 *   - acceptBooking  (caregiver-booking.service.ts) — เลย acceptDeadline แล้วรับงานไม่ได้
 *   - createPayment  (payment.service.ts)           — เลย paymentDeadline แล้วจ่ายเงินไม่ได้
 *   - BookingExpiryService (cron)                   — เลย deadline + buffer แล้วปิด booking เป็น expired
 *
 * booking ไม่มีคอลัมน์ deadline แยก → deadline = เวลาเริ่มงาน (booking_date + start_time ตามเวลาไทย)
 * + grace ของแต่ละขั้น เวลาเริ่มงานคำนวณผ่าน scheduledStartOf() ตัวเดียวกับระบบเช็คอิน/QR
 * (start_time เป็นคอลัมน์ TIME — ต้องประกอบกับ booking_date เสมอ ดู booking-schedule.util.ts)
 *
 * ★ ไม่มีตัวเลข policy ใน business logic — ทุกค่าอยู่ที่นี่และ override ได้ผ่าน ENV
 */
import { envInt } from '../monitoring/monitoring.constants';
import { scheduledStartOf } from '../monitoring/booking-schedule.util';

/**
 * ผู้ดูแลกดรับงานได้ช้ากว่าเวลาเริ่มงานได้กี่นาที
 *
 * TODO(product): รอทีมเคาะ — default 0 = ปลอดภัยที่สุด (ต้องรับงานก่อนเวลาเริ่มงาน)
 * ค่าติดลบได้ เช่น -60 = ต้องรับงานก่อนเริ่มงานอย่างน้อย 1 ชม.
 */
export const ACCEPT_GRACE_MINUTES = envInt('ACCEPT_GRACE_MINUTES', 0);

/**
 * ผู้ป่วยชำระเงินได้ช้ากว่าเวลาเริ่มงานได้กี่นาที
 *
 * TODO(product): รอทีมเคาะ — default 0 = ปลอดภัยที่สุด (ต้องจ่ายก่อนเวลาเริ่มงาน)
 */
export const PAYMENT_GRACE_MINUTES = envInt('PAYMENT_GRACE_MINUTES', 0);

/**
 * ระยะเผื่อของ cron หมดอายุ (ไม่ใช่ policy — เป็นตัวกัน race):
 * cron จะปิด booking เมื่อเลย deadline + ค่านี้เท่านั้น
 *
 * เหตุผล: createPayment (บัตร) ตรวจ deadline ก่อนเรียก Omise แล้วค่อยเขียน booking=confirmed
 * ใน tx แบบไม่มีเงื่อนไข ถ้า cron ปิด booking ระหว่างนั้น tx ของ createPayment จะเขียนทับ expired
 * → buffer นี้ทำให้ request ที่ผ่าน guard ก่อน deadline มีเวลาจบก่อน cron จะมาแตะ
 * (15 นาที > timeout ปริยายของ fetch/undici ที่ 300 วินาที ที่ Omise call ถูกตัดแน่นอน)
 */
export const BOOKING_EXPIRY_BUFFER_MINUTES = envInt(
  'BOOKING_EXPIRY_BUFFER_MINUTES',
  15,
);

/**
 * kill-switch ของ cron หมดอายุ — default = ปิด (มติ 2026-09-11)
 * ต้องตั้ง BOOKING_EXPIRY_CRON_ENABLED=true เองหลัง FE รองรับสถานะ 'expired' แล้ว
 * (กลับทิศกับ PAYOUT_KILLSWITCH_ENABLED ของ PYG-331 ที่ไม่ตั้ง = ทำงาน — ตัวนี้ไม่ตั้ง = ไม่ทำงาน)
 */
export const BOOKING_EXPIRY_ENABLED_ENV = 'BOOKING_EXPIRY_CRON_ENABLED';

/**
 * สาเหตุย่อยที่เขียนลง booking_status_history.reason
 * ★ ค่าต้องตรงกับ SettlementReason ของ BookingSettlementService (เฟส 2) — ใช้คำเดียวกันทั้งระบบ
 */
export const EXPIRY_REASON = {
  NO_ACCEPT: 'expired_no_accept',
  NO_PAYMENT: 'expired_no_payment',
} as const;

const MINUTE_MS = 60 * 1000;
const THAILAND_UTC_OFFSET_MS = 7 * 60 * MINUTE_MS;

/** เวลาสุดท้ายที่ผู้ดูแลยังกดรับงานได้ */
export function acceptDeadlineOf(
  bookingDate: Date,
  startTime: Date | null,
): Date {
  const start = scheduledStartOf(bookingDate, startTime);
  return new Date(start.getTime() + ACCEPT_GRACE_MINUTES * MINUTE_MS);
}

/** เวลาสุดท้ายที่ผู้ป่วยยังสร้าง payment ได้ */
export function paymentDeadlineOf(
  bookingDate: Date,
  startTime: Date | null,
): Date {
  const start = scheduledStartOf(bookingDate, startTime);
  return new Date(start.getTime() + PAYMENT_GRACE_MINUTES * MINUTE_MS);
}

/** แสดงเวลาเป็นนาฬิกาไทยในข้อความ error/แจ้งเตือน เช่น "2026-07-01 09:00 (เวลาไทย)" */
export function toBangkokText(d: Date): string {
  const shifted = new Date(d.getTime() + THAILAND_UTC_OFFSET_MS);
  return `${shifted.toISOString().slice(0, 16).replace('T', ' ')} (เวลาไทย)`;
}

/** วันที่ตามปฏิทินไทยของ `now` ในรูป DATE (UTC midnight) — ใช้กรอง booking_date */
export function bangkokDateOf(now: Date): Date {
  const shifted = new Date(now.getTime() + THAILAND_UTC_OFFSET_MS);
  return new Date(
    Date.UTC(
      shifted.getUTCFullYear(),
      shifted.getUTCMonth(),
      shifted.getUTCDate(),
    ),
  );
}
