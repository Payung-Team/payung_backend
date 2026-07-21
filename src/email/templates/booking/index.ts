/**
 * Booking lifecycle email templates registry
 *
 * Maps eventType → template function — listener ใช้ตัวนี้เลือก template
 * undefined → fallback ไปใช้ bookingNotificationTemplate (generic)
 *
 * 11/11 email events มี per-event template
 * (payment_voided ไม่ส่งอีเมล — ไม่มีใน registry)
 */
import { BOOKING_EVENTS, type BookingEventType } from '../../../notification/events/booking-event';
import { bookingCreatedTemplate } from './created.template';
import { bookingAcceptedTemplate } from './accepted.template';
import { bookingDeclinedTemplate } from './declined.template';
import { bookingConfirmedTemplate } from './confirmed.template';
import { bookingCompletedTemplate } from './completed.template';
import { bookingCancelledTemplate } from './cancelled.template';
import { paymentHeldTemplate } from './payment-held.template';
import { paymentCapturedTemplate } from './payment-captured.template';
import { refundIssuedTemplate } from './refund-issued.template';
import { disputeCreatedTemplate } from './dispute-created.template';
import { disputeResolvedTemplate } from './dispute-resolved.template';
import type { BookingTemplateFn } from './types';

export {
  bookingCreatedTemplate,
  bookingAcceptedTemplate,
  bookingDeclinedTemplate,
  bookingConfirmedTemplate,
  bookingCompletedTemplate,
  bookingCancelledTemplate,
  paymentHeldTemplate,
  paymentCapturedTemplate,
  refundIssuedTemplate,
  disputeCreatedTemplate,
  disputeResolvedTemplate,
};
export type { BookingTemplateFn, BookingEmailContext, RecipientRole } from './types';

/** per-event mapping — undefined → ใช้ fallback (bookingNotificationTemplate) */
export const BOOKING_EMAIL_TEMPLATES: Partial<Record<BookingEventType, BookingTemplateFn>> = {
  [BOOKING_EVENTS.CREATED]: bookingCreatedTemplate,
  [BOOKING_EVENTS.ACCEPTED]: bookingAcceptedTemplate,
  [BOOKING_EVENTS.DECLINED]: bookingDeclinedTemplate,
  [BOOKING_EVENTS.CONFIRMED]: bookingConfirmedTemplate,
  [BOOKING_EVENTS.COMPLETED]: bookingCompletedTemplate,
  [BOOKING_EVENTS.CANCELLED]: bookingCancelledTemplate,
  [BOOKING_EVENTS.PAYMENT_HELD]: paymentHeldTemplate,
  [BOOKING_EVENTS.PAYMENT_CAPTURED]: paymentCapturedTemplate,
  [BOOKING_EVENTS.REFUND_ISSUED]: refundIssuedTemplate,
  [BOOKING_EVENTS.DISPUTE_CREATED]: disputeCreatedTemplate,
  [BOOKING_EVENTS.DISPUTE_RESOLVED]: disputeResolvedTemplate,
};
