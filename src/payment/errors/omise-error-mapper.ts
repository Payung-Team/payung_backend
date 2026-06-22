import { UnprocessableEntityException } from '@nestjs/common';

export type PaymentErrorDetails = {
  omiseChargeId?: string;
  omiseCode?: string;
  omiseMessage?: string;
  httpStatus?: number;
};

export class PaymentError extends UnprocessableEntityException {
  readonly code: string;
  readonly message_th: string;
  readonly message_en: string;

  constructor(
    code: string,
    message_th: string,
    message_en: string,
    readonly details: PaymentErrorDetails = {},
  ) {
    super({
      statusCode: 422,
      message: message_en,
      error: 'Unprocessable Entity',
      code,
      message_th,
      message_en,
    });
    this.code = code;
    this.message_th = message_th;
    this.message_en = message_en;
  }
}

/**
 * Maps Omise failure codes to a PaymentError object.
 */
export function mapOmiseError(
  failureCode: string | undefined,
  failureMessage: string | undefined,
  details: PaymentErrorDetails = {},
): PaymentError {
  let message_th = 'เกิดข้อผิดพลาดในการชำระเงิน กรุณาลองใหม่อีกครั้ง';
  let message_en = 'Payment failed. Please try again.';

  if (failureCode === 'insufficient_fund') {
    message_th = 'ยอดเงินในบัตรไม่เพียงพอ';
    message_en = 'Insufficient funds in the card.';
  } else if (failureCode === 'stolen_or_lost_card') {
    message_th = 'บัตรถูกอายัดหรือสูญหาย';
    message_en = 'Stolen or lost card.';
  } else if (failureCode === 'failed_processing') {
    message_th = 'ระบบธนาคารขัดข้องชั่วคราว';
    message_en = 'Bank processing failed temporarily.';
  } else if (failureCode === 'payment_rejected') {
    message_th = 'ธนาคารปฏิเสธการชำระเงิน กรุณาติดต่อธนาคารเจ้าของบัตร';
    message_en = 'Payment rejected by the bank. Please contact your issuer.';
  } else if (failureCode === 'invalid_security_code') {
    message_th = 'รหัสความปลอดภัย (CVV/CVC) ไม่ถูกต้อง';
    message_en = 'Invalid security code (CVV/CVC).';
  } else if (failureCode) {
    message_th = `การชำระเงินล้มเหลว (${failureCode})`;
    message_en = failureMessage || `Payment failed (${failureCode})`;
  }

  return new PaymentError('PAYMENT_FAILED', message_th, message_en, details);
}
