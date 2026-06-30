/**
 * booking.confirmed (PYG-293) — แจ้งทั้งสองฝ่ายว่าจองยืนยันแล้ว (หลังชำระเงินสำเร็จ)
 * Subject: "[Payung] การจองยืนยันแล้ว"
 *
 * Render ต่างกันตาม recipientRole:
 *   - patient   → "เราได้ยืนยันการจองของคุณแล้ว"
 *   - caregiver → "ลูกค้าชำระเงินแล้ว เตรียมตัวให้บริการ"
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

export const bookingConfirmedTemplate: BookingTemplateFn = (ctx): EmailTemplate => {
  const subject = '[Payung] การจองยืนยันแล้ว';
  const heading = 'การจองของคุณได้รับการยืนยันแล้ว';

  const intro =
    ctx.recipientRole === 'patient'
      ? `เราได้ยืนยันการจองของคุณกับคุณ${escapeHtml(ctx.caregiverName)} เรียบร้อยแล้ว — กรุณาเตรียมพร้อมในวันให้บริการ`
      : `ลูกค้าชำระเงินและยืนยันการจองแล้ว — กรุณาเตรียมตัวให้บริการตามวันและเวลาที่ระบุ`;

  // CG เห็นเบอร์ติดต่อลูกค้า (จาก patientName); PT เห็นเบอร์ผู้ดูแล
  const contactRow =
    ctx.recipientRole === 'patient' && ctx.caregiverPhone
      ? `<p style="margin:8px 0 0; font-size:14px; color:#6B7773;">ติดต่อผู้ดูแล: <strong style="color:#1A2422;">${escapeHtml(ctx.caregiverPhone)}</strong></p>`
      : '';

  const summary = formatBookingSummary({
    caregiverName: ctx.recipientRole === 'patient' ? ctx.caregiverName : undefined,
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
    ${contactRow}
  `;

  const ctaUrl = `${ctx.frontendUrl}/bookings/${ctx.bookingId}`;
  const ctaLabel = 'ดูรายละเอียด';

  const text = `${plainGreeting(ctx.recipientName)},

${heading}
${ctx.recipientRole === 'patient'
  ? `เราได้ยืนยันการจองของคุณกับคุณ${ctx.caregiverName} แล้ว`
  : 'ลูกค้าชำระเงินและยืนยันการจองแล้ว เตรียมตัวให้บริการ'}
${plainBookingSummary({
  caregiverName: ctx.recipientRole === 'patient' ? ctx.caregiverName : undefined,
  dateText: ctx.dateText,
  timeText: ctx.timeText,
  serviceText: ctx.serviceText,
  locationAddress: ctx.locationAddress,
  totalText: ctx.totalText,
})}${ctx.recipientRole === 'patient' && ctx.caregiverPhone ? `ติดต่อผู้ดูแล: ${ctx.caregiverPhone}\n` : ''}
${ctaLabel}: ${ctaUrl}${plainTextFooter(ctx.frontendUrl)}`;

  return {
    subject,
    html: wrapHtml({ bodyHtml, ctaUrl, ctaLabel, frontendUrl: ctx.frontendUrl }),
    text,
  };
};
