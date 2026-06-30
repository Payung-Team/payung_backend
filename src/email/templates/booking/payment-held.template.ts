/**
 * payment.held (PYG-293) — แจ้ง Patient ว่าชำระเงิน (กันวงเงิน) เรียบร้อย
 * Subject: "[Payung] ชำระเงินเรียบร้อย"
 *
 * payment_method: "บัตรเครดิต" + chargeId (ตัด Visa ••••/last4 — DB ไม่เก็บ)
 * แสดง breakdown: ค่าบริการ + ค่าดำเนินการ 10% + ยอดรวม
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

export const paymentHeldTemplate: BookingTemplateFn = (ctx): EmailTemplate => {
  const subject = '[Payung] ชำระเงินเรียบร้อย';
  const heading = 'ชำระเงินเรียบร้อยแล้ว';
  const intro = `เราได้กันวงเงิน <strong>${escapeHtml(ctx.paymentAmountText)}</strong> ไว้สำหรับการจองของคุณกับคุณ${escapeHtml(ctx.caregiverName)} แล้ว — จะเรียกเก็บเมื่อบริการเสร็จสิ้น`;

  const paymentMethodText = ctx.chargeId
    ? `บัตรเครดิต (ref: ${ctx.chargeId})`
    : 'บัตรเครดิต';

  const breakdown = summaryTable(
    [
      summaryRow('การจอง', ctx.serviceText),
      summaryRow('วันที่', ctx.dateText),
      summaryRow('เวลา', ctx.timeText),
      summaryRow('ค่าบริการ', ctx.serviceCostText),
      summaryRow('ค่าดำเนินการ (10%)', ctx.platformFeeText),
      summaryRow('ยอดรวม', ctx.totalText, { bold: true }),
      summaryRow('วิธีชำระเงิน', paymentMethodText),
    ].join(''),
  );

  const bodyHtml = `
    <p>${greeting(ctx.recipientName)},</p>
    <h2 style="font-size:20px; color:#1A2422; margin:8px 0 12px;">${escapeHtml(heading)}</h2>
    <p>${intro}</p>
    ${breakdown}
  `;

  const ctaUrl = `${ctx.frontendUrl}/bookings/${ctx.bookingId}`;
  const ctaLabel = 'ดูใบเสร็จ';

  const text = `${plainGreeting(ctx.recipientName)},

${heading}
กันวงเงิน ${ctx.paymentAmountText} สำหรับการจองกับคุณ${ctx.caregiverName}
จะเรียกเก็บเมื่อบริการเสร็จสิ้น

การจอง: ${ctx.serviceText}
วันที่: ${ctx.dateText}
เวลา: ${ctx.timeText}
ค่าบริการ: ${ctx.serviceCostText}
ค่าดำเนินการ (10%): ${ctx.platformFeeText}
ยอดรวม: ${ctx.totalText}
วิธีชำระเงิน: ${paymentMethodText}

${ctaLabel}: ${ctaUrl}${plainTextFooter(ctx.frontendUrl)}`;

  return {
    subject,
    html: wrapHtml({ bodyHtml, ctaUrl, ctaLabel, frontendUrl: ctx.frontendUrl }),
    text,
  };
};
