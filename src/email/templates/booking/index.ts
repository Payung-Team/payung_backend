/**
 * Booking lifecycle email templates registry (PYG-293, Wave 1)
 *
 * Maps eventType → template function — listener ใช้ตัวนี้เลือก template
 *
 * Wave 1 (live emitters ใน dev): created/accepted/declined/confirmed/completed/
 *                                 payment_held/payment_captured/refund_issued
 * Wave 2 (รอ emitter): cancelled/dispute_created/dispute_resolved/payment_voided
 *                      → fallback ไปใช้ bookingNotificationTemplate (template เดิม)
 */
import { BOOKING_EVENTS, type BookingEventType } from '../../../notification/events/booking-event';
import { bookingCreatedTemplate } from './created.template';
import { bookingAcceptedTemplate } from './accepted.template';
import { bookingDeclinedTemplate } from './declined.template';
import { bookingConfirmedTemplate } from './confirmed.template';
import { bookingCompletedTemplate } from './completed.template';
import { paymentHeldTemplate } from './payment-held.template';
import { paymentCapturedTemplate } from './payment-captured.template';
import { refundIssuedTemplate } from './refund-issued.template';
import type { BookingTemplateFn } from './types';

export {
  bookingCreatedTemplate,
  bookingAcceptedTemplate,
  bookingDeclinedTemplate,
  bookingConfirmedTemplate,
  bookingCompletedTemplate,
  paymentHeldTemplate,
  paymentCapturedTemplate,
  refundIssuedTemplate,
};
export type { BookingTemplateFn, BookingEmailContext, RecipientRole } from './types';

/** Wave 1 mapping — undefined → ใช้ fallback (bookingNotificationTemplate) */
export const BOOKING_EMAIL_TEMPLATES: Partial<Record<BookingEventType, BookingTemplateFn>> = {
  [BOOKING_EVENTS.CREATED]: bookingCreatedTemplate,
  [BOOKING_EVENTS.ACCEPTED]: bookingAcceptedTemplate,
  [BOOKING_EVENTS.DECLINED]: bookingDeclinedTemplate,
  [BOOKING_EVENTS.CONFIRMED]: bookingConfirmedTemplate,
  [BOOKING_EVENTS.COMPLETED]: bookingCompletedTemplate,
  [BOOKING_EVENTS.PAYMENT_HELD]: paymentHeldTemplate,
  [BOOKING_EVENTS.PAYMENT_CAPTURED]: paymentCapturedTemplate,
  [BOOKING_EVENTS.REFUND_ISSUED]: refundIssuedTemplate,
};
