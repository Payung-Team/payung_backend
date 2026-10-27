/**
 * payment.captured (PYG-293) — แจ้งทั้งสองฝ่ายว่าระบบเรียกเก็บเงินสำเร็จ (หลังบริการเสร็จ)
 * Subject: "เรียกเก็บเงินแล้ว — Payung"
 *
 * Render ต่างกันตาม recipientRole:
 *   - patient   → "เราเรียกเก็บเงินจากบัตรของคุณเรียบร้อย"
 *   - caregiver → "ลูกค้าชำระเรียบร้อย ค่าตอบแทนของคุณ X จะถูกโอน" — X = ค่าตอบแทน (totalText) ไม่ใช่ยอดที่ลูกค้าจ่าย
 */
import {
  wrapHtml,
  plainTextFooter,
  escapeHtml,
  emailSubject,
  titleBlock,
  moneySummary,
} from '../layout';
import type { EmailTemplate } from '../kyc.templates';
import type { BookingTemplateFn } from './types';
import { bookingDetailUrl, greeting, plainGreeting } from './helpers';

export const paymentCapturedTemplate: BookingTemplateFn = (
  ctx,
): EmailTemplate => {
  const subject = emailSubject('เรียกเก็บเงินแล้ว');
  const heading = 'เรียกเก็บเงินสำเร็จ';

  const intro =
    ctx.recipientRole === 'patient'
      ? `เราได้เรียกเก็บเงิน <strong>${escapeHtml(ctx.paymentAmountText)}</strong> จากบัตรของคุณเรียบร้อยแล้ว สำหรับบริการของคุณ${escapeHtml(ctx.caregiverName)}`
      : // ผู้ดูแลเห็นค่าตอบแทนของตัวเอง (totalText) ไม่ใช่ยอดที่ลูกค้าจ่ายซึ่งรวมค่าธรรมเนียมแพลตฟอร์ม
        `ลูกค้าชำระค่าบริการเรียบร้อยแล้ว — ค่าตอบแทนของคุณ <strong>${escapeHtml(ctx.totalText)}</strong> จะถูกโอนตามรอบที่กำหนด`;

  const paymentMethodText = ctx.chargeId
    ? `บัตรเครดิต (ref: ${ctx.chargeId})`
    : 'บัตรเครดิต';

  const breakdown = moneySummary({
    rows: [
      ['บริการ', ctx.serviceText],
      ['วันที่', ctx.dateText],
    ],
    total:
      ctx.recipientRole === 'caregiver'
        ? ['ค่าตอบแทนของคุณ', ctx.totalText]
        : ['ยอดที่เรียกเก็บ', ctx.paymentAmountText],
    // วิธีชำระเงินเป็นข้อมูลของผู้จ่าย — ผู้ดูแลไม่ต้องเห็น
    note:
      ctx.recipientRole === 'patient'
        ? `ชำระด้วย${paymentMethodText}`
        : undefined,
  });

  const bodyHtml = `
    ${titleBlock(heading, `${greeting(ctx.recipientName)} ${intro}`)}
    ${breakdown}
  `;

  const ctaUrl = bookingDetailUrl(ctx);
  const ctaLabel =
    ctx.recipientRole === 'patient' ? 'ดูใบเสร็จ' : 'ดูรายละเอียดงาน';

  const text = `${plainGreeting(ctx.recipientName)}

${heading}
${
  ctx.recipientRole === 'patient'
    ? `เราเรียกเก็บเงิน ${ctx.paymentAmountText} จากบัตรของคุณแล้ว — บริการกับคุณ${ctx.caregiverName}`
    : `ลูกค้าชำระค่าบริการเรียบร้อย — ค่าตอบแทน ${ctx.totalText} จะถูกโอนตามรอบ`
}

การจอง: ${ctx.serviceText}
วันที่: ${ctx.dateText}
${ctx.recipientRole === 'caregiver' ? `ค่าตอบแทนของคุณ: ${ctx.totalText}` : `ยอดที่เรียกเก็บ: ${ctx.paymentAmountText}`}${ctx.recipientRole === 'patient' ? `\nวิธีชำระเงิน: ${paymentMethodText}` : ''}

${ctaLabel}: ${ctaUrl}${plainTextFooter(ctx.frontendUrl)}`;

  return {
    subject,
    html: wrapHtml({
      bodyHtml,
      ctaUrl,
      ctaLabel,
      frontendUrl: ctx.frontendUrl,
      badge: { label: 'เรียกเก็บแล้ว', tone: 'info' },
    }),
    text,
  };
};
