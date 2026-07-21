/**
 * booking.accepted (PYG-293) — แจ้ง Patient ว่าผู้ดูแลรับคำขอแล้ว
 * Subject: "[Payung] ผู้ดูแลรับคำขอแล้ว"
 *
 * ความสำคัญ: ปุ่ม CTA = "ชำระเงินเพื่อยืนยัน" (จองยังไม่ confirmed จนกว่าจะ pay)
 */
import { wrapHtml, plainTextFooter, escapeHtml } from '../layout';
import type { EmailTemplate } from '../kyc.templates';
import type { BookingTemplateFn } from './types';
import {
  greeting,
  plainGreeting,
  formatBookingSummary,
  plainBookingSummary,
} from './helpers';

export const bookingAcceptedTemplate: BookingTemplateFn = (
  ctx,
): EmailTemplate => {
  const subject = '[Payung] ผู้ดูแลรับคำขอแล้ว';
  const heading = 'ผู้ดูแลรับคำขอจองของคุณแล้ว';
  const intro = `คุณ${escapeHtml(ctx.caregiverName)} ตอบรับคำขอของคุณแล้ว — กรุณาชำระเงินเพื่อยืนยันการจองภายในเวลาที่กำหนด`;

  const summary = formatBookingSummary({
    caregiverName: ctx.caregiverName,
    ratingText: ctx.caregiverRatingText,
    dateText: ctx.dateText,
    timeText: ctx.timeText,
    serviceText: ctx.serviceText,
    locationAddress: ctx.locationAddress,
    totalText: ctx.totalText,
  });

  const bodyHtml = `
    <p>${greeting(ctx.recipientName)},</p>
    <h2 style="font-size:20px; color:#1A2422; margin:8px 0 12px;">${escapeHtml(heading)}</h2>
    <p>${intro}</p>
    ${summary}
  `;

  const ctaUrl = `${ctx.frontendUrl}/bookings/${ctx.bookingId}`;
  const ctaLabel = 'ชำระเงินเพื่อยืนยัน';

  const text = `${plainGreeting(ctx.recipientName)},

${heading}
คุณ${ctx.caregiverName} ตอบรับคำขอของคุณแล้ว — กรุณาชำระเงินเพื่อยืนยัน
${plainBookingSummary({
  caregiverName: ctx.caregiverName,
  ratingText: ctx.caregiverRatingText,
  dateText: ctx.dateText,
  timeText: ctx.timeText,
  serviceText: ctx.serviceText,
  locationAddress: ctx.locationAddress,
  totalText: ctx.totalText,
})}
${ctaLabel}: ${ctaUrl}${plainTextFooter(ctx.frontendUrl)}`;

  return {
    subject,
    html: wrapHtml({
      bodyHtml,
      ctaUrl,
      ctaLabel,
      frontendUrl: ctx.frontendUrl,
    }),
    text,
  };
};
