/**
 * InvalidPayoutTransitionError — throw เมื่อ state machine ปฏิเสธการ transition
 * ที่ไม่อยู่ใน VALID_TRANSITIONS (mirror InvalidPaymentTransitionError)
 */
import { PayoutStatus } from '../entities/payout-status.enum';

export class InvalidPayoutTransitionError extends Error {
  readonly from: PayoutStatus;
  readonly to: PayoutStatus;

  constructor(from: PayoutStatus, to: PayoutStatus) {
    super(`Invalid payout transition: ${from} → ${to}`);
    this.name = 'InvalidPayoutTransitionError';
    this.from = from;
    this.to = to;
  }
}
