/**
 * InvalidPaymentTransitionError — error ที่โยนเมื่อพยายามเปลี่ยน payment status
 * แบบที่ FSM ไม่อนุญาต (PYG-277)
 *
 * ตัวอย่างที่ผิด: held → pending (ย้อนกลับ), captured → held, failed → captured
 *
 * ทำไม extends UnprocessableEntityException (HTTP 422)?
 * - 422 = "เข้าใจคำขอ แต่ทำตามไม่ได้เพราะผิดกฎทางธุรกิจ" → ตรงความหมายที่สุด
 * - codebase นี้ใช้ UnprocessableEntityException กับเคส business-state อื่น
 *   (เช่น booking ที่สถานะไม่ถูกต้อง) อยู่แล้ว → สอดคล้องกัน
 * - การ extends exception ของ Nest ทำให้ GraphQL/REST แปลงเป็น error response
 *   ที่อ่านรู้เรื่องให้อัตโนมัติ (ไม่ใช่ 500 internal error)
 *
 * เก็บ from/to ไว้บน error ด้วย → service อื่นที่ catch จะรู้ว่าพังจากสถานะอะไรไปอะไร
 */
import { UnprocessableEntityException } from '@nestjs/common';

export class InvalidPaymentTransitionError extends UnprocessableEntityException {
  /** รหัส error คงที่ — frontend/หรือ log ใช้แยกแยะ error ชนิดนี้ได้ */
  readonly code = 'INVALID_PAYMENT_TRANSITION';

  constructor(
    readonly from: string,
    readonly to: string,
  ) {
    super(`ไม่สามารถเปลี่ยนสถานะการชำระเงินจาก "${from}" เป็น "${to}" ได้`);
  }
}
