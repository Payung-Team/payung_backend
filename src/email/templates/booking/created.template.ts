/**
 * booking.created (PYG-293) — แจ้ง Caregiver ว่ามีคำขอจองใหม่
 * Subject: "คุณมีคำขอจองใหม่ — Payung"
 */
import {
  wrapHtml,
  plainTextFooter,
  escapeHtml,
  emailSubject,
  HEADING_STYLE,
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

export const bookingCreatedTemplate: BookingTemplateFn = (
  ctx,
): EmailTemplate => {
  const subject = emailSubject('คุณมีคำขอจองใหม่');
  const heading = 'มีคำขอจองใหม่รอคุณตอบรับ';
  const intro = ctx.patientName
    ? `คุณ${escapeHtml(ctx.patientName)} ส่งคำขอจองบริการของคุณเข้ามาแล้ว — กรุณาตรวจสอบและตอบรับภายในเวลาที่กำหนด`
    : 'มีผู้ใช้บริการส่งคำขอจองบริการของคุณ — กรุณาตรวจสอบและตอบรับ';

  const summary = formatBookingSummary({
    dateText: ctx.dateText,
    timeText: ctx.timeText,
    serviceText: ctx.serviceText,
    locationAddress: ctx.locationAddress,
    totalText: ctx.totalText,
  });

  const bodyHtml = `
    <p>${greeting(ctx.recipientName)}</p>
    <h2 style="${HEADING_STYLE}">${escapeHtml(heading)}</h2>
    <p>${intro}</p>
    ${summary}
  `;

  const ctaUrl = bookingDetailUrl(ctx);
  const ctaLabel = 'ดูคำขอจอง';

  const text = `${plainGreeting(ctx.recipientName)}

${heading}
${ctx.patientName ? `คุณ${ctx.patientName} ส่งคำขอจองเข้ามา — กรุณาตอบรับ` : 'มีผู้ใช้บริการส่งคำขอจอง'}
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
