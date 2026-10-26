/**
 * payment.held (PYG-293) — แจ้ง Patient ว่าชำระเงิน (กันวงเงิน) เรียบร้อย
 * Subject: "ชำระเงินเรียบร้อย — Payung"
 *
 * payment_method: "บัตรเครดิต" + chargeId (ตัด Visa ••••/last4 — DB ไม่เก็บ)
 * แสดงยอดรวม (= ยอดที่เรียกเก็บจริง) เสมอ; บรรทัดค่าบริการ/ค่าธรรมเนียมแสดงเฉพาะเมื่อมี
 * platform_fee จริง (ตอนนี้ NULL ทุกแถว → ซ่อน — ดู formatPriceBreakdown)
 */
import {
  wrapHtml,
  plainTextFooter,
  escapeHtml,
  emailSubject,
  titleBlock,
  moneySummary,
  detailTable,
} from '../layout';
import type { EmailTemplate } from '../kyc.templates';
import type { BookingTemplateFn } from './types';
import { bookingDetailUrl, greeting, plainGreeting } from './helpers';

export const paymentHeldTemplate: BookingTemplateFn = (ctx): EmailTemplate => {
  const subject = emailSubject('ชำระเงินเรียบร้อย');
  const heading = 'ชำระเงินเรียบร้อยแล้ว';
  const intro = `เราได้กันวงเงิน <strong>${escapeHtml(ctx.paymentAmountText)}</strong> ไว้สำหรับการจองของคุณกับคุณ${escapeHtml(ctx.caregiverName)} แล้ว — จะเรียกเก็บเมื่อบริการเสร็จสิ้น`;

  const paymentMethodText = ctx.chargeId
    ? `บัตรเครดิต (ref: ${ctx.chargeId})`
    : 'บัตรเครดิต';

  // ค่าบริการ/ค่าธรรมเนียม: แสดงเฉพาะเมื่อมี platform_fee จริง (undefined = ซ่อน)
  const breakdown = moneySummary({
    rows: [
      ...(ctx.serviceCostText
        ? [['ค่าบริการ', ctx.serviceCostText] as [string, string]]
        : []),
      ...(ctx.platformFeeText
        ? [['ค่าดำเนินการ', ctx.platformFeeText] as [string, string]]
        : []),
    ],
    total: ['ยอดรวม', ctx.totalText],
    note: `ชำระด้วย${paymentMethodText}`,
  });
  const booking = detailTable([
    { label: 'บริการ', value: ctx.serviceText },
    { label: 'วันและเวลา', value: `${ctx.dateText} · ${ctx.timeText}` },
  ]);

  const bodyHtml = `
    ${titleBlock(heading, `${greeting(ctx.recipientName)} ${intro}`)}
    ${breakdown}
    ${booking}
  `;

  const ctaUrl = bookingDetailUrl(ctx);
  const ctaLabel = 'ดูใบเสร็จ';

  const text = `${plainGreeting(ctx.recipientName)}

${heading}
กันวงเงิน ${ctx.paymentAmountText} สำหรับการจองกับคุณ${ctx.caregiverName}
จะเรียกเก็บเมื่อบริการเสร็จสิ้น

${[
  `การจอง: ${ctx.serviceText}`,
  `วันที่: ${ctx.dateText}`,
  `เวลา: ${ctx.timeText}`,
  ...(ctx.serviceCostText ? [`ค่าบริการ: ${ctx.serviceCostText}`] : []),
  ...(ctx.platformFeeText ? [`ค่าดำเนินการ: ${ctx.platformFeeText}`] : []),
  `ยอดรวม: ${ctx.totalText}`,
  `วิธีชำระเงิน: ${paymentMethodText}`,
].join('\n')}

${ctaLabel}: ${ctaUrl}${plainTextFooter(ctx.frontendUrl)}`;

  return {
    subject,
    html: wrapHtml({
      bodyHtml,
      ctaUrl,
      ctaLabel,
      frontendUrl: ctx.frontendUrl,
      badge: { label: 'ชำระแล้ว', tone: 'success' },
    }),
    text,
  };
};
