/**
 * dispute.created — แจ้ง Admin ว่ามีปัญหาใหม่ที่ต้องตรวจสอบ
 * Subject: "[Payung] แจ้งปัญหาใหม่"
 */
import { wrapHtml, plainTextFooter, escapeHtml } from '../layout';
import type { EmailTemplate } from '../kyc.templates';
import type { BookingTemplateFn } from './types';
import {
  greeting,
  plainGreeting,
  formatBookingSummary,
  plainBookingSummary,
  summaryRow,
  summaryTable,
} from './helpers';

export const disputeCreatedTemplate: BookingTemplateFn = (
  ctx,
): EmailTemplate => {
  const subject = '[Payung] แจ้งปัญหาใหม่';
  const heading = 'มีการแจ้งปัญหาใหม่ที่ต้องตรวจสอบ';
  const intro = `มีการแจ้งปัญหาสำหรับการจองบริการ${escapeHtml(ctx.serviceText)} วันที่ ${escapeHtml(ctx.dateText)} — กรุณาตรวจสอบและดำเนินการ`;

  const parties = summaryTable(
    [
      ...(ctx.patientName ? [summaryRow('ผู้ใช้บริการ', ctx.patientName)] : []),
      summaryRow('ผู้ดูแล', ctx.caregiverName),
    ].join(''),
  );

  const reasonBlock = ctx.declineReason
    ? `
      <div style="background:#fff8e1; border-left:4px solid #f9a825; padding:12px 16px; margin:16px 0;">
        <p style="margin:0; font-weight:600; color:#f57f17;">รายละเอียดปัญหา:</p>
        <p style="margin:8px 0 0;">${escapeHtml(ctx.declineReason)}</p>
      </div>`
    : '';

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
    ${parties}
    ${reasonBlock}
    ${summary}
  `;

  const ctaUrl = `${ctx.frontendUrl}/admin/disputes`;
  const ctaLabel = 'ดูคิวปัญหา';

  const text = `${plainGreeting(ctx.recipientName)},

${heading}
มีการแจ้งปัญหาสำหรับการจองบริการ${ctx.serviceText} วันที่ ${ctx.dateText}
${ctx.patientName ? `ผู้ใช้บริการ: ${ctx.patientName}\n` : ''}ผู้ดูแล: ${ctx.caregiverName}${ctx.declineReason ? `\n\nรายละเอียดปัญหา: ${ctx.declineReason}` : ''}
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
