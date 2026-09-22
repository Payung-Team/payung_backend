/**
 * สัญญาของ BookingSettlementService (PYG-461/462 เฟส 2)
 */
import { UnprocessableEntityException } from '@nestjs/common';

/**
 * สาเหตุที่ปิด booking — ค่าเป็น string เพื่อเขียนลง booking_status_history.reason ตรง ๆ
 * ★ expired_no_accept / expired_no_payment ต้องตรงกับ EXPIRY_REASON ของ cron เฟส 1
 *   (src/booking/booking-deadline.config.ts) — ใช้คำเดียวกันทั้งระบบ
 */
export enum SettlementReason {
  /** PYG-461 เฟส 3a — ผู้ป่วยกดยกเลิกเอง */
  PATIENT_CANCEL = 'patient_cancel',
  /** PYG-462 เคส 1 — ไม่มีผู้ดูแลรับงานก่อนเวลา */
  EXPIRED_NO_ACCEPT = 'expired_no_accept',
  /** PYG-462 เคส 2 — ผู้ป่วยไม่ได้ชำระเงินก่อนเวลา */
  EXPIRED_NO_PAYMENT = 'expired_no_payment',
  /** PYG-462 เคส 3 (เฟส 3b) — ผู้ดูแลไม่มาตามนัด */
  CAREGIVER_NO_SHOW = 'caregiver_no_show',
}

export type ActorRole = 'patient' | 'caregiver' | 'admin' | 'system';

/** ใครสั่งปิด — id = users.id หรือ null เมื่อเป็นระบบ/cron */
export interface Actor {
  id: string | null;
  role: ActorRole;
}

/** เงินขยับอย่างไรในการ settle ครั้งนี้ */
export type MoneyAction = 'none' | 'voided' | 'refunded' | 'promptpay_expired';

export interface SettlementResult {
  bookingId: string;
  reason: SettlementReason;
  /** true = booking อยู่ในสถานะปลายทางอยู่แล้ว (เรียกซ้ำ) — ไม่มีเงินขยับ */
  alreadySettled: boolean;
  bookingStatusBefore: string;
  bookingStatusAfter: string;
  moneyAction: MoneyAction;
  paymentStatusBefore: string | null;
  paymentStatusAfter: string | null;
  /** ยอดที่คืนในการเรียกครั้งนี้ (บาท) — null ถ้าไม่ได้คืน */
  refundAmount: number | null;
  /** % ที่นโยบายกำหนด — null ถ้าไม่มีเงินให้คืน */
  refundPercentage: number | null;
}

/**
 * รหัสเหตุที่ settle ไม่ได้ — ผู้เรียก (เฟส 3) ใช้ตัดสินใจต่อ:
 *   promptpay_still_scannable / omise_unreachable / state_changed_retry = ชั่วคราว ลองรอบหน้าได้
 *   ที่เหลือ = ต้องมีคน/นโยบายตัดสิน ห้าม retry วน
 */
export type SettlementBlockCode =
  | 'booking_not_settleable'
  | 'payment_not_settleable'
  | 'payout_already_released'
  | 'promptpay_still_scannable'
  | 'omise_unreachable'
  | 'state_changed_retry'
  | 'policy_not_supported';

const RETRYABLE: ReadonlySet<SettlementBlockCode> =
  new Set<SettlementBlockCode>([
    'promptpay_still_scannable',
    'omise_unreachable',
    'state_changed_retry',
  ]);

/** 422 พร้อม code + ข้อมูลว่าติดอะไร (response body: { code, message, retryable, details }) */
export class SettlementBlockedError extends UnprocessableEntityException {
  readonly retryable: boolean;

  constructor(
    readonly code: SettlementBlockCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    const retryable = RETRYABLE.has(code);
    super({ code, message, retryable, details });
    this.retryable = retryable;
  }
}
