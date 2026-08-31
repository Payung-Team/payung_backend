/**
 * booking.cancelled — แจ้ง Caregiver ว่าผู้ใช้บริการยกเลิกการจอง
 * Subject: "[Payung] การจองถูกยกเลิก"
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

export const bookingCancelledTemplate: BookingTemplateFn = (
  ctx,
): EmailTemplate => {
  const subject = '[Payung] การจองถูกยกเลิก';
  const heading = 'การจองถูกยกเลิกโดยผู้ใช้บริการ';
  const intro = ctx.patientName
    ? `คุณ${escapeHtml(ctx.patientName)} ได้ยกเลิกการจองบริการ${escapeHtml(ctx.serviceText)} วันที่ ${escapeHtml(ctx.dateText)} แล้ว`
    : `ผู้ใช้บริการได้ยกเลิกการจองบริการ${escapeHtml(ctx.serviceText)} วันที่ ${escapeHtml(ctx.dateText)} แล้ว`;

  const summary = formatBookingSummary({
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
  const ctaLabel = 'ดูรายละเอียด';

  const text = `${plainGreeting(ctx.recipientName)},

${heading}
${
  ctx.patientName
    ? `คุณ${ctx.patientName} ยกเลิกการจองบริการ${ctx.serviceText} วันที่ ${ctx.dateText}`
    : `ผู้ใช้บริการยกเลิกการจองบริการ${ctx.serviceText} วันที่ ${ctx.dateText}`
}
${plainBookingSummary({
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
