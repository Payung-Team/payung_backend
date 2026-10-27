/**
 * dispute.created — แจ้ง Admin ว่ามีปัญหาใหม่ที่ต้องตรวจสอบ
 * Subject: "แจ้งปัญหาใหม่ — Payung"
 */
import {
  wrapHtml,
  plainTextFooter,
  escapeHtml,
  emailSubject,
  titleBlock,
  noteBox,
} from '../layout';
import type { EmailTemplate } from '../kyc.templates';
import type { BookingTemplateFn } from './types';
import {
  greeting,
  plainGreeting,
  formatBookingSummary,
  plainBookingSummary,
} from './helpers';

export const disputeCreatedTemplate: BookingTemplateFn = (
  ctx,
): EmailTemplate => {
  const subject = emailSubject('แจ้งปัญหาใหม่');
  const heading = 'มีการแจ้งปัญหาใหม่ที่ต้องตรวจสอบ';
  const intro = `มีการแจ้งปัญหาสำหรับการจองบริการ${escapeHtml(ctx.serviceText)} วันที่ ${escapeHtml(ctx.dateText)} — กรุณาตรวจสอบและดำเนินการ`;

  const summary = formatBookingSummary({
    dateText: ctx.dateText,
    timeText: ctx.timeText,
    serviceText: ctx.serviceText,
    locationAddress: ctx.locationAddress,
    totalText: ctx.totalText,
    totalLabel: ctx.totalLabel,
    extraRows: [
      ...(ctx.patientName
        ? [{ label: 'ผู้ใช้บริการ', value: ctx.patientName }]
        : []),
      { label: 'ผู้ดูแล', value: ctx.caregiverName },
    ],
  });
  const reasonBlock = ctx.declineReason
    ? noteBox(
        `<strong>รายละเอียดที่ผู้แจ้งเขียน:</strong><br>${escapeHtml(ctx.declineReason)}`,
      )
    : '';

  const bodyHtml = `
    ${titleBlock(heading, `${greeting(ctx.recipientName)} ${intro}`)}
    ${summary}
    ${reasonBlock}
  `;

  const ctaUrl = `${ctx.frontendUrl}/admin/disputes`;
  const ctaLabel = 'ดูคิวปัญหา';

  const text = `${plainGreeting(ctx.recipientName)}

${heading}
มีการแจ้งปัญหาสำหรับการจองบริการ${ctx.serviceText} วันที่ ${ctx.dateText}
${ctx.patientName ? `ผู้ใช้บริการ: ${ctx.patientName}\n` : ''}ผู้ดูแล: ${ctx.caregiverName}${ctx.declineReason ? `\n\nรายละเอียดปัญหา: ${ctx.declineReason}` : ''}
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
      badge: { label: 'ต้องตรวจสอบ', tone: 'danger' },
      audience: 'admin',
      supportHtml:
        'อีเมลอัตโนมัติถึงทีมแอดมิน · ห้ามส่งต่อนอกองค์กร (มีข้อมูลส่วนบุคคล)',
    }),
    text,
  };
};
