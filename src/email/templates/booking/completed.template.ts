/**
 * booking.completed (PYG-293) — แจ้งทั้งสองฝ่ายว่าบริการเสร็จสิ้น
 * Subject: "[Payung] บริการเสร็จสิ้น"
 *
 * Render ต่างกันตาม recipientRole:
 *   - patient   → CTA "ให้คะแนนผู้ดูแล" → /bookings/{id}/review
 *   - caregiver → CTA "ดูสรุปงาน" → /bookings/{id} (จะแจ้งเรื่อง payout แยก ticket)
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

export const bookingCompletedTemplate: BookingTemplateFn = (
  ctx,
): EmailTemplate => {
  const subject = '[Payung] บริการเสร็จสิ้น';
  const heading = 'บริการเสร็จสิ้นแล้ว ขอบคุณที่ใช้บริการ Payung';

  const intro =
    ctx.recipientRole === 'patient'
      ? `บริการของคุณ${escapeHtml(ctx.caregiverName)} เสร็จสมบูรณ์แล้ว — ความคิดเห็นของคุณจะช่วยให้ผู้ดูแลและผู้ใช้ท่านอื่นได้ประโยชน์`
      : `งานบริการของคุณเสร็จสมบูรณ์แล้ว ขอบคุณที่ดูแลผู้ใช้ของเราเป็นอย่างดี — ระบบจะดำเนินการเรื่องค่าตอบแทนตามขั้นตอนต่อไป`;

  const summary = formatBookingSummary({
    caregiverName:
      ctx.recipientRole === 'patient' ? ctx.caregiverName : undefined,
    dateText: ctx.dateText,
    timeText: ctx.timeText,
    serviceText: ctx.serviceText,
    totalText: ctx.totalText,
  });

  const bodyHtml = `
    <p>${greeting(ctx.recipientName)},</p>
    <h2 style="font-size:20px; color:#1A2422; margin:8px 0 12px;">${escapeHtml(heading)}</h2>
    <p>${intro}</p>
    ${summary}
  `;

  const ctaUrl =
    ctx.recipientRole === 'patient'
      ? `${ctx.frontendUrl}/bookings/${ctx.bookingId}/review`
      : `${ctx.frontendUrl}/bookings/${ctx.bookingId}`;
  const ctaLabel =
    ctx.recipientRole === 'patient' ? 'ให้คะแนนผู้ดูแล' : 'ดูสรุปงาน';

  const text = `${plainGreeting(ctx.recipientName)},

${heading}
${
  ctx.recipientRole === 'patient'
    ? `บริการของคุณ${ctx.caregiverName} เสร็จสมบูรณ์ — ให้คะแนนเพื่อช่วยผู้ใช้ท่านอื่น`
    : 'งานบริการเสร็จสมบูรณ์ ขอบคุณ — ระบบจะดำเนินการค่าตอบแทนต่อไป'
}
${plainBookingSummary({
  caregiverName:
    ctx.recipientRole === 'patient' ? ctx.caregiverName : undefined,
  dateText: ctx.dateText,
  timeText: ctx.timeText,
  serviceText: ctx.serviceText,
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
