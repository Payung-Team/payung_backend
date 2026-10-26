/**
 * booking.accepted (PYG-293) — แจ้ง Patient ว่าผู้ดูแลรับคำขอแล้ว
 * Subject: "ผู้ดูแลรับคำขอแล้ว — Payung"
 *
 * ความสำคัญ: ปุ่ม CTA = "ชำระเงินเพื่อยืนยัน" (จองยังไม่ confirmed จนกว่าจะ pay)
 */
import {
  wrapHtml,
  plainTextFooter,
  escapeHtml,
  emailSubject,
  titleBlock,
} from '../layout';
import type { EmailTemplate } from '../kyc.templates';
import type { BookingTemplateFn } from './types';
import {
  bookingDetailUrl,
  greeting,
  plainGreeting,
  formatBookingSummary,
  plainBookingSummary,
} from './helpers';

export const bookingAcceptedTemplate: BookingTemplateFn = (
  ctx,
): EmailTemplate => {
  const subject = emailSubject('ผู้ดูแลรับคำขอแล้ว');
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
    ${titleBlock(heading, `${greeting(ctx.recipientName)} ${intro}`)}
    ${summary}
  `;

  const ctaUrl = bookingDetailUrl(ctx);
  const ctaLabel = 'ชำระเงินเพื่อยืนยัน';

  const text = `${plainGreeting(ctx.recipientName)}

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
      badge: { label: 'รอชำระเงิน', tone: 'warning' },
    }),
    text,
  };
};
