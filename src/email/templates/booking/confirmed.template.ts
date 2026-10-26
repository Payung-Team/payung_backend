/**
 * booking.confirmed (PYG-293) — แจ้งทั้งสองฝ่ายว่าจองยืนยันแล้ว (หลังชำระเงินสำเร็จ)
 * Subject: "การจองยืนยันแล้ว — Payung"
 *
 * Render ต่างกันตาม recipientRole:
 *   - patient   → "เราได้ยืนยันการจองของคุณแล้ว"
 *   - caregiver → "ลูกค้าชำระเงินแล้ว เตรียมตัวให้บริการ"
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

export const bookingConfirmedTemplate: BookingTemplateFn = (
  ctx,
): EmailTemplate => {
  const subject = emailSubject('การจองยืนยันแล้ว');
  const heading = 'การจองของคุณได้รับการยืนยันแล้ว';

  const intro =
    ctx.recipientRole === 'patient'
      ? `เราได้ยืนยันการจองของคุณกับคุณ${escapeHtml(ctx.caregiverName)} เรียบร้อยแล้ว — กรุณาเตรียมพร้อมในวันให้บริการ`
      : `ลูกค้าชำระเงินและยืนยันการจองแล้ว — กรุณาเตรียมตัวให้บริการตามวันและเวลาที่ระบุ`;

  const summary = formatBookingSummary({
    caregiverName:
      ctx.recipientRole === 'patient' ? ctx.caregiverName : undefined,
    // ผู้รับบริการเห็นเบอร์ผู้ดูแลต่อท้ายชื่อ (design: "ชื่อ · เบอร์")
    caregiverPhone:
      ctx.recipientRole === 'patient' ? ctx.caregiverPhone : undefined,
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
  const ctaLabel = 'ดูรายละเอียด';

  const text = `${plainGreeting(ctx.recipientName)}

${heading}
${
  ctx.recipientRole === 'patient'
    ? `เราได้ยืนยันการจองของคุณกับคุณ${ctx.caregiverName} แล้ว`
    : 'ลูกค้าชำระเงินและยืนยันการจองแล้ว เตรียมตัวให้บริการ'
}
${plainBookingSummary({
  caregiverName:
    ctx.recipientRole === 'patient' ? ctx.caregiverName : undefined,
  dateText: ctx.dateText,
  timeText: ctx.timeText,
  serviceText: ctx.serviceText,
  locationAddress: ctx.locationAddress,
  totalText: ctx.totalText,
})}${ctx.recipientRole === 'patient' && ctx.caregiverPhone ? `ติดต่อผู้ดูแล: ${ctx.caregiverPhone}\n` : ''}
${ctaLabel}: ${ctaUrl}${plainTextFooter(ctx.frontendUrl)}`;

  return {
    subject,
    html: wrapHtml({
      bodyHtml,
      ctaUrl,
      ctaLabel,
      frontendUrl: ctx.frontendUrl,
      badge: { label: 'ยืนยันแล้ว', tone: 'success' },
    }),
    text,
  };
};
