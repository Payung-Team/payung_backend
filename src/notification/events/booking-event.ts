/**
 * Booking lifecycle events (PYG-292)
 *
 * ที่เดียวที่นิยาม "ชื่อ event" + "หน้าตา payload" ของ booking/payment/dispute events
 * - service ฝั่งคนยิง (booking, payment, complete-booking) import ค่าคงที่จากที่นี่
 * - BookingNotificationListener ฝั่งคนรับก็ใช้ type เดียวกัน → ทั้งระบบตรงกันเสมอ
 *
 * ทำไมใช้ชื่อแบบมี "." (เช่น 'booking.created')?
 * - เป็น convention ของ EventEmitter2 (namespacing)
 * - แต่ "ไม่" ได้เปิด wildcard ใน EventEmitterModule.forRoot() — listener ใช้ @OnEvent
 *   ชื่อเต็มแบบเป๊ะ ๆ (exact match) เพื่อไม่ให้ไปจับ event อื่นที่ขึ้นต้น 'payment.'
 *   โดยไม่ตั้งใจ (เช่น 'payment.expired' จาก payment-cron, 'payment.transferred')
 */

/** ชื่อ event ทั้งหมดของ booking lifecycle — ใช้ค่าคงที่เพื่อกันพิมพ์ผิด */
export const BOOKING_EVENTS = {
  CREATED: 'booking.created',
  ACCEPTED: 'booking.accepted',
  DECLINED: 'booking.declined',
  CONFIRMED: 'booking.confirmed',
  COMPLETED: 'booking.completed',
  CANCELLED: 'booking.cancelled',
  // PYG-352: ผู้ดูแลเช็คอินเริ่มงาน — แจ้งผู้รับบริการว่าผู้ดูแลมาถึงแล้ว
  JOB_CHECKED_IN: 'job.checked_in',
  // PYG-358: ผู้ดูแลเช็คเอาท์ = ปิดงาน (ผู้รับบริการไม่ต้องยืนยันอีกแล้ว)
  // ต่างจาก COMPLETED ตรงที่ตอนนี้ "ยังไม่ได้เก็บเงิน" — รอ cron ปล่อยเงินอีกที
  JOB_CHECKED_OUT: 'job.checked_out',
  // PYG-359: ผู้ดูแลลืมเช็คเอาท์ → ระบบปิดงานให้ (system row) แล้วส่งเข้าคิว admin
  JOB_NO_CHECKOUT: 'job.no_checkout',
  PAYMENT_HELD: 'payment.held',
  PAYMENT_CAPTURED: 'payment.captured',
  // PYG-286: hold ถูกยกเลิก (auto-void on cancel) — แจ้ง patient ว่า hold ถูกปล่อย
  PAYMENT_VOIDED: 'payment.voided',
  REFUND_ISSUED: 'refund.issued',
  DISPUTE_CREATED: 'dispute.created',
  DISPUTE_RESOLVED: 'dispute.resolved',
  // PYG-266: admin โอนเงินให้ caregiver ผ่าน Omise Transfer สำเร็จ
  PAYMENT_TRANSFERRED: 'payment.transferred',
} as const;

/** union ของชื่อ event (derive จาก BOOKING_EVENTS — เพิ่มที่เดียวพอ) */
export type BookingEventType =
  (typeof BOOKING_EVENTS)[keyof typeof BOOKING_EVENTS];

/**
 * Payload ของทุก booking/payment/dispute event
 *
 * @property bookingId   - id ของ booking (listener ใช้โหลดรายละเอียดเพิ่มเติม)
 * @property eventType   - ชนิด event (listener ใช้ map → recipient + เนื้อหา)
 * @property patientId   - USER id ของ patient (ไม่ใช่ booking.patientId profile — ตรงกันอยู่แล้ว)
 * @property caregiverId - USER id ของ caregiver (caregiver.userId) — null ถ้ายังไม่มีคนรับ
 * @property metadata    - ข้อมูลเสริมเฉพาะ event เช่น { reason } ตอน decline, { amount } ตอน refund
 *
 * หมายเหตุ: รายละเอียดสำหรับอีเมล (ชื่อผู้ดูแล/วันที่/บริการ/ยอดเงิน) listener จะ
 * โหลดสด ๆ จาก DB ด้วย bookingId เอง — ฝั่งคนยิงไม่ต้องแนบมาให้ครบ ลดโอกาสส่งข้อมูลไม่ตรง
 */
export interface BookingEvent {
  bookingId: string;
  eventType: BookingEventType;
  patientId: string;
  caregiverId: string | null;
  metadata?: Record<string, unknown>;
}
