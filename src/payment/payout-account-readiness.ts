/**
 * payout-account-readiness — กติกากลางว่า "บัญชีรับเงินพร้อมรับโอนหรือยัง"
 *
 * ตัวเลือก C ของการ์ดสถานะ Omise vs KYC: admin อนุมัติ KYC ได้เลย (ไม่รอ Omise)
 * แต่ caregiver เปิดรับงานได้ต่อเมื่อ Omise accept บัญชีแล้ว
 *
 * เงื่อนไขเดียวกับที่ PaymentService.createPayment ใช้ตอนผู้ป่วยจ่ายเงิน
 * และที่ PayoutWorkerService ใช้ก่อนโอน — รวมไว้ที่เดียวเพื่อไม่ให้สามที่เพี้ยนจากกัน
 */

/** error code ที่ FE ใช้แยกเคส "ยังเปิดรับงานไม่ได้เพราะบัญชีรับเงินยังไม่ผ่าน Omise" */
export const PAYOUT_ACCOUNT_NOT_READY = 'PAYOUT_ACCOUNT_NOT_READY';

export type PayoutReadinessReason =
  | 'NO_ACCOUNT' // ยังไม่ได้กรอกบัญชี (step นี้ใน KYC ข้ามได้)
  | 'PENDING' // กรอกแล้ว รอ Omise ตรวจ/ยังไม่ active
  | 'FAILED'; // Omise ปฏิเสธ — caregiver ต้องแก้บัญชี

export interface PayoutReadiness {
  ready: boolean;
  /** undefined เมื่อ ready = true */
  reason?: PayoutReadinessReason;
}

export function evaluatePayoutReadiness(
  account: {
    status: string;
    recipientStatus: string;
    omiseRecipientId: string | null;
  } | null | undefined,
): PayoutReadiness {
  if (!account) return { ready: false, reason: 'NO_ACCOUNT' };
  if (account.recipientStatus === 'failed') return { ready: false, reason: 'FAILED' };
  if (
    account.status === 'active' &&
    account.recipientStatus === 'verified' &&
    account.omiseRecipientId
  ) {
    return { ready: true };
  }
  return { ready: false, reason: 'PENDING' };
}

/** ข้อความภาษาไทยสำหรับ ForbiddenException ตามเหตุผล */
export const PAYOUT_NOT_READY_MESSAGES: Record<PayoutReadinessReason, string> = {
  NO_ACCOUNT: 'กรุณาเพิ่มบัญชีรับเงินก่อนจึงจะเปิดรับงานได้',
  PENDING: 'บัญชีรับเงินของคุณอยู่ระหว่างการตรวจสอบโดย Omise จะเปิดรับงานได้เมื่อตรวจสอบเสร็จสิ้น',
  FAILED: 'บัญชีรับเงินของคุณไม่ผ่านการตรวจสอบ กรุณาแก้ไขข้อมูลบัญชีรับเงินแล้วลองใหม่',
};
