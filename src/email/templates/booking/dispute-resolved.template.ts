/**
 * dispute.resolved — แจ้งทั้งสองฝ่ายว่าผลการตรวจสอบพร้อมแล้ว
 * Subject: "ผลตรวจสอบปัญหา — Payung"
 *
 * Render ต่างกันตาม recipientRole:
 *   - patient   → เน้นผลสำหรับผู้ใช้บริการ
 *   - caregiver → เน้นผลสำหรับผู้ดูแล
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

export const disputeResolvedTemplate: BookingTemplateFn = (
  ctx,
): EmailTemplate => {
  const subject = emailSubject('ผลตรวจสอบปัญหา');
  const heading = 'ผลการตรวจสอบปัญหาพร้อมแล้ว';

  const intro =
    ctx.recipientRole === 'patient'
      ? `ทีม Payung ได้ตรวจสอบปัญหาสำหรับการจองบริการ${escapeHtml(ctx.serviceText)} วันที่ ${escapeHtml(ctx.dateText)} เรียบร้อยแล้ว — กรุณาดูรายละเอียดผลการดำเนินการ`
      : `ทีม Payung ได้ตรวจสอบปัญหาสำหรับการจองบริการ${escapeHtml(ctx.serviceText)} วันที่ ${escapeHtml(ctx.dateText)} เรียบร้อยแล้ว — กรุณาดูรายละเอียดผลการดำเนินการ`;

  const summary = formatBookingSummary({
    caregiverName:
      ctx.recipientRole === 'patient' ? ctx.caregiverName : undefined,
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
  const ctaLabel = 'ดูผลการตรวจสอบ';

  const text = `${plainGreeting(ctx.recipientName)}

${heading}
ผลการตรวจสอบปัญหาสำหรับการจองบริการ${ctx.serviceText} วันที่ ${ctx.dateText} พร้อมแล้ว
${plainBookingSummary({
  caregiverName:
    ctx.recipientRole === 'patient' ? ctx.caregiverName : undefined,
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
      badge: { label: 'ตรวจสอบแล้ว', tone: 'success' },
    }),
    text,
  };
};
