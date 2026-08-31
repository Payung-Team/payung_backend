/**
 * payment.captured (PYG-293) — แจ้งทั้งสองฝ่ายว่าระบบเรียกเก็บเงินสำเร็จ (หลังบริการเสร็จ)
 * Subject: "[Payung] เรียกเก็บเงินแล้ว"
 *
 * Render ต่างกันตาม recipientRole:
 *   - patient   → "เราเรียกเก็บเงินจากบัตรของคุณเรียบร้อย"
 *   - caregiver → "ระบบเรียกเก็บเงินจากลูกค้าเรียบร้อย เตรียมโอนค่าตอบแทน"
 */
import { wrapHtml, plainTextFooter, escapeHtml } from '../layout';
import type { EmailTemplate } from '../kyc.templates';
import type { BookingTemplateFn } from './types';
import {
  greeting,
  plainGreeting,
  summaryRow,
  summaryTable,
} from './helpers';

export const paymentCapturedTemplate: BookingTemplateFn = (ctx): EmailTemplate => {
  const subject = '[Payung] เรียกเก็บเงินแล้ว';
  const heading = 'เรียกเก็บเงินสำเร็จ';

  const intro =
    ctx.recipientRole === 'patient'
      ? `เราได้เรียกเก็บเงิน <strong>${escapeHtml(ctx.paymentAmountText)}</strong> จากบัตรของคุณเรียบร้อยแล้ว สำหรับบริการของคุณ${escapeHtml(ctx.caregiverName)}`
      : `ระบบได้เรียกเก็บเงิน <strong>${escapeHtml(ctx.paymentAmountText)}</strong> จากลูกค้าเรียบร้อย — ค่าตอบแทนของคุณจะถูกโอนตามรอบที่กำหนด`;

  const paymentMethodText = ctx.chargeId
    ? `บัตรเครดิต (ref: ${ctx.chargeId})`
    : 'บัตรเครดิต';

  const rows = [
    summaryRow('การจอง', ctx.serviceText),
    summaryRow('วันที่', ctx.dateText),
    summaryRow('ยอดที่เรียกเก็บ', ctx.paymentAmountText, { bold: true }),
  ];
  if (ctx.recipientRole === 'patient') {
    rows.push(summaryRow('วิธีชำระเงิน', paymentMethodText));
  }

  const bodyHtml = `
    <p>${greeting(ctx.recipientName)},</p>
    <h2 style="font-size:20px; color:#1A2422; margin:8px 0 12px;">${escapeHtml(heading)}</h2>
    <p>${intro}</p>
    ${summaryTable(rows.join(''))}
  `;

  const ctaUrl = `${ctx.frontendUrl}/bookings/${ctx.bookingId}`;
  const ctaLabel = ctx.recipientRole === 'patient' ? 'ดูใบเสร็จ' : 'ดูรายละเอียดงาน';

  const text = `${plainGreeting(ctx.recipientName)},

${heading}
${ctx.recipientRole === 'patient'
  ? `เราเรียกเก็บเงิน ${ctx.paymentAmountText} จากบัตรของคุณแล้ว — บริการกับคุณ${ctx.caregiverName}`
  : `เรียกเก็บเงิน ${ctx.paymentAmountText} จากลูกค้าเรียบร้อย — ค่าตอบแทนจะถูกโอนตามรอบ`}

การจอง: ${ctx.serviceText}
วันที่: ${ctx.dateText}
ยอดที่เรียกเก็บ: ${ctx.paymentAmountText}${ctx.recipientRole === 'patient' ? `\nวิธีชำระเงิน: ${paymentMethodText}` : ''}

${ctaLabel}: ${ctaUrl}${plainTextFooter(ctx.frontendUrl)}`;

  return {
    subject,
    html: wrapHtml({ bodyHtml, ctaUrl, ctaLabel, frontendUrl: ctx.frontendUrl }),
    text,
  };
};
