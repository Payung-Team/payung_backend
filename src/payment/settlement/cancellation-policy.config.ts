/**
 * นโยบายคืนเงินตอนปิด booking — PYG-461/462 เฟส 2 (ใช้โดย BookingSettlementService เท่านั้น)
 *
 * ★ ห้าม hardcode ตัวเลขนโยบายใน business logic — ทุกค่าอยู่ที่นี่ที่เดียว
 * ★ ตั้งใจ "ไม่" ให้ override ผ่าน ENV (ต่างจาก grace ของเฟส 1) — นโยบายเงินต้องเปลี่ยนผ่าน code review
 * ★ grace ของการรับงาน/ชำระเงิน (ACCEPT_GRACE_MINUTES / PAYMENT_GRACE_MINUTES) อยู่ที่
 *   src/booking/booking-deadline.config.ts ใน PR phase-1 — แยกไฟล์เพื่อไม่ให้สอง PR ชนกัน
 *
 * ค่าที่มี TODO(product) = ทีมยังไม่เคาะ → ใส่ค่าที่ "ปลอดภัยที่สุดต่อผู้ป่วย" ไว้ก่อน
 * (ไม่หักเงินผู้ป่วยโดยไม่มีนโยบายที่ตกลงกันแล้ว)
 *
 * เป็น object ไม่ freeze โดยตั้งใจ — เทสใช้ jest.replaceProperty จำลองนโยบายอื่นได้
 */

export type FeeBorneBy = 'platform' | 'patient';

export const CANCELLATION_POLICY = {
  /** ผู้ป่วยยกเลิกก่อนเวลาเริ่มงาน >= เท่านี้ชั่วโมง → คืนเต็ม */
  CANCELLATION_FULL_REFUND_CUTOFF_HOURS: 24,

  /**
   * ผู้ป่วยยกเลิกช้ากว่า cutoff → คืนกี่ %
   * TODO(product): รอทีมเคาะ — default 100 = ปลอดภัยที่สุด (ยังไม่หักจนกว่าจะมีนโยบาย)
   */
  LATE_CANCELLATION_REFUND_PERCENTAGE: 100,

  /** ผู้ดูแลไม่มา — ผู้ป่วยไม่ผิด คืนเต็มเสมอ */
  CAREGIVER_NO_SHOW_REFUND_PERCENTAGE: 100,

  /** ระบบปิดให้เพราะเลยเวลา (expired_no_accept / expired_no_payment) — ไม่หัก (มติ 2026-09-11) */
  SYSTEM_CLOSED_REFUND_PERCENTAGE: 100,

  /**
   * ค่าธรรมเนียม Omise ใครเป็นคนแบก
   * TODO(product): รอทีมเคาะ — default 'platform' = ปลอดภัยที่สุดต่อผู้ป่วย
   * 'patient' ยังไม่ implement (ต้องรู้อัตราค่าธรรมเนียมจริง) → settle จะปฏิเสธ policy_not_supported
   * แทนการเดาตัวเลข
   */
  OMISE_FEE_BORNE_BY: 'platform' as FeeBorneBy,
};

/**
 * timeout ของ transaction ที่ถือ FOR UPDATE คร่อม Omise HTTP (ไม่ใช่ policy — เป็น infra)
 * ต้องยาวกว่า OMISE_HTTP_TIMEOUT_MS (default 10s ใน OmiseService) ชัดเจน
 * ค่าเดียวกับ RefundService (20s) เพราะ settle เรียก Omise ได้มากสุด 1 ครั้งต่อ tx
 */
export const SETTLEMENT_TX_TIMEOUT_MS = 20_000;
