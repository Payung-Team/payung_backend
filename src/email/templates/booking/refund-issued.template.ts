/**
 * refund.issued (PYG-293) — แจ้ง Patient ว่าคืนเงินเรียบร้อย
 * Subject: "[Payung] คืนเงินเรียบร้อย ฿{amount}"
 *
 * payment_method: "บัตรเครดิต" + chargeId (จำเป็นต้องอ้างอิงถึง charge เดิม)
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

export const refundIssuedTemplate: BookingTemplateFn = (ctx): EmailTemplate => {
  const amountText = ctx.refundAmountText ?? ctx.paymentAmountText;
  const subject = `[Payung] คืนเงินเรียบร้อย ${amountText}`;
  const heading = 'คืนเงินเรียบร้อยแล้ว';
  const intro = `เราได้คืนเงิน <strong>${escapeHtml(amountText)}</strong> กลับไปยังบัตรของคุณเรียบร้อย — ยอดเงินจะแสดงในรายการบัตรของคุณภายใน 5-10 วันทำการ`;

  const paymentMethodText = ctx.chargeId
    ? `บัตรเครดิต (ref: ${ctx.chargeId})`
    : 'บัตรเครดิต';

  const breakdown = summaryTable(
    [
      summaryRow('การจอง', ctx.serviceText),
      summaryRow('วันที่', ctx.dateText),
      summaryRow('ยอดคืนเงิน', amountText, { bold: true }),
      summaryRow('คืนเข้าบัตร', paymentMethodText),
    ].join(''),
  );

  const bodyHtml = `
    <p>${greeting(ctx.recipientName)},</p>
    <h2 style="font-size:20px; color:#1A2422; margin:8px 0 12px;">${escapeHtml(heading)}</h2>
    <p>${intro}</p>
    ${breakdown}
  `;

  const ctaUrl = `${ctx.frontendUrl}/bookings/${ctx.bookingId}`;
  const ctaLabel = 'ดูรายละเอียด';

  const text = `${plainGreeting(ctx.recipientName)},

${heading}
คืนเงิน ${amountText} กลับไปยังบัตรของคุณแล้ว
ยอดเงินจะแสดงในรายการบัตรของคุณภายใน 5-10 วันทำการ

การจอง: ${ctx.serviceText}
วันที่: ${ctx.dateText}
ยอดคืนเงิน: ${amountText}
คืนเข้าบัตร: ${paymentMethodText}

${ctaLabel}: ${ctaUrl}${plainTextFooter(ctx.frontendUrl)}`;

  return {
    subject,
    html: wrapHtml({ bodyHtml, ctaUrl, ctaLabel, frontendUrl: ctx.frontendUrl }),
    text,
  };
};
