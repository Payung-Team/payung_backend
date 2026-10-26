/**
 * refund.issued (PYG-293) — แจ้ง Patient ว่าคืนเงินเรียบร้อย
 * Subject: "คืนเงินเรียบร้อย ฿{amount} — Payung"
 *
 * payment_method: "บัตรเครดิต" + chargeId (จำเป็นต้องอ้างอิงถึง charge เดิม)
 */
import {
  wrapHtml,
  plainTextFooter,
  escapeHtml,
  emailSubject,
  titleBlock,
  amountHero,
  detailTable,
} from '../layout';
import type { EmailTemplate } from '../kyc.templates';
import type { BookingTemplateFn } from './types';
import { bookingDetailUrl, greeting, plainGreeting } from './helpers';

export const refundIssuedTemplate: BookingTemplateFn = (ctx): EmailTemplate => {
  const amountText = ctx.refundAmountText ?? ctx.paymentAmountText;
  const subject = emailSubject(`คืนเงินเรียบร้อย ${amountText}`);
  const heading = 'คืนเงินเรียบร้อยแล้ว';
  const intro = `เราได้คืนเงิน <strong>${escapeHtml(amountText)}</strong> กลับไปยังบัตรของคุณเรียบร้อย — ยอดเงินจะแสดงในรายการบัตรของคุณภายใน 5-10 วันทำการ`;

  const paymentMethodText = ctx.chargeId
    ? `บัตรเครดิต (ref: ${ctx.chargeId})`
    : 'บัตรเครดิต';

  const breakdown = `${amountHero('ยอดคืนเงิน', amountText, `คืนเข้า${paymentMethodText}`)}${detailTable(
    [
      { label: 'บริการ', value: ctx.serviceText },
      { label: 'วันที่', value: ctx.dateText },
    ],
  )}`;

  const bodyHtml = `
    ${titleBlock(heading, `${greeting(ctx.recipientName)} ${intro}`)}
    ${breakdown}
  `;

  const ctaUrl = bookingDetailUrl(ctx);
  const ctaLabel = 'ดูรายละเอียด';

  const text = `${plainGreeting(ctx.recipientName)}

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
    html: wrapHtml({
      bodyHtml,
      ctaUrl,
      ctaLabel,
      frontendUrl: ctx.frontendUrl,
      badge: { label: 'คืนเงินแล้ว', tone: 'success' },
    }),
    text,
  };
};
