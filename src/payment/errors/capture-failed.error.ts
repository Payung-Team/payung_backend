/**
 * CaptureFailedError — error ที่โยนเมื่อ "capture" เงินกับ Omise ไม่สำเร็จ (PYG-281)
 *
 * เกิดเมื่อไหร่:
 * - booking เสร็จงาน → ระบบสั่ง omise.charges.capture(omiseChargeId) เพื่อตัดเงินจริง
 *   จากวงเงินที่ "held" ไว้ตอน checkout แต่ Omise ตอบกลับว่าไม่สำเร็จ
 *   (เช่น hold หมดอายุ, การ์ดมีปัญหา, หรือ gateway error)
 *
 * ทำไม extends UnprocessableEntityException (HTTP 422)?
 * - 422 = "เข้าใจคำขอ แต่ทำตามไม่ได้เพราะผิดกฎ/สถานะทางธุรกิจ" → ตรงความหมาย
 * - สอดคล้องกับ InvalidPaymentTransitionError (PYG-277) ที่ใช้ 422 เช่นกัน
 * - ทำให้ GraphQL/REST แปลงเป็น error response ที่อ่านรู้เรื่อง (ไม่ใช่ 500)
 *
 * เก็บรายละเอียดจาก Omise (code/message/chargeId) ไว้บน error → ชั้นที่ catch
 * จะนำไป log ลง payment_status_history + แจ้ง admin ได้ครบถ้วน
 */
import { UnprocessableEntityException } from '@nestjs/common';

/** รายละเอียดเสริมที่แนบมากับ error เพื่อใช้ตอน audit/แจ้งเตือน */
export type CaptureFailureDetails = {
  /** charge id ของ Omise ที่พยายาม capture */
  omiseChargeId?: string;
  /** failure code จาก Omise (เช่น 'failed_capture', 'expired_charge') */
  omiseCode?: string;
  /** ข้อความ error ดิบจาก Omise (สำหรับ debug/log) */
  omiseMessage?: string;
  /** HTTP status ที่ Omise ตอบกลับ (ถ้ามี) */
  httpStatus?: number;
};

export class CaptureFailedError extends UnprocessableEntityException {
  /** รหัส error คงที่ — frontend/log ใช้แยกแยะ error ชนิดนี้ได้ */
  readonly code = 'CAPTURE_FAILED';

  constructor(
    message: string,
    /** รายละเอียดจาก Omise — ชั้นที่ catch เอาไปบันทึก history + แจ้ง admin */
    readonly details: CaptureFailureDetails = {},
  ) {
    super(message);
  }
}
