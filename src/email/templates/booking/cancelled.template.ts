/**
 * booking.cancelled — แจ้ง Caregiver ว่าผู้ใช้บริการยกเลิกการจอง
 * Subject: "การจองถูกยกเลิก — Payung"
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

export const bookingCancelledTemplate: BookingTemplateFn = (
  ctx,
): EmailTemplate => {
  const subject = emailSubject('การจองถูกยกเลิก');
  const heading = 'การจองถูกยกเลิกโดยผู้ใช้บริการ';
  const intro = ctx.patientName
    ? `คุณ${escapeHtml(ctx.patientName)} ได้ยกเลิกการจองบริการ${escapeHtml(ctx.serviceText)} วันที่ ${escapeHtml(ctx.dateText)} แล้ว`
    : `ผู้ใช้บริการได้ยกเลิกการจองบริการ${escapeHtml(ctx.serviceText)} วันที่ ${escapeHtml(ctx.dateText)} แล้ว`;

  const summary = formatBookingSummary({
    strikeDate: true,
    dateText: ctx.dateText,
    timeText: ctx.timeText,
    serviceText: ctx.serviceText,
    locationAddress: ctx.locationAddress,
    totalText: ctx.totalText,
    totalLabel: ctx.totalLabel,
  });

  const bodyHtml = `
    ${titleBlock(heading, `${greeting(ctx.recipientName)} ${intro}`)}
    ${summary}
  `;

  const ctaUrl = bookingDetailUrl(ctx);
  const ctaLabel = 'ดูรายละเอียด';

  const text = `${plainGreeting(ctx.recipientName)}

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
  totalLabel: ctx.totalLabel,
})}
${ctaLabel}: ${ctaUrl}${plainTextFooter(ctx.frontendUrl)}`;

  return {
    subject,
    html: wrapHtml({
      bodyHtml,
      ctaUrl,
      ctaLabel,
      frontendUrl: ctx.frontendUrl,
      badge: { label: 'ยกเลิกแล้ว', tone: 'neutral' },
    }),
    text,
  };
};
