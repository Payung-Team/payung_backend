/**
 * booking.completed (PYG-293) — แจ้งทั้งสองฝ่ายว่าบริการเสร็จสิ้น
 * Subject: "บริการเสร็จสิ้น — Payung"
 *
 * Render ต่างกันตาม recipientRole:
 *   - patient   → CTA "ให้คะแนนผู้ดูแล" → /bookings/{id} (ฟอร์มให้คะแนนอยู่ในหน้านี้)
 *   - caregiver → CTA "ดูสรุปงาน" → /caregiver/bookings/{id} (จะแจ้งเรื่อง payout แยก ticket)
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

export const bookingCompletedTemplate: BookingTemplateFn = (
  ctx,
): EmailTemplate => {
  const subject = emailSubject('บริการเสร็จสิ้น');
  const heading = 'บริการเสร็จสิ้นแล้ว ขอบคุณที่ใช้บริการ Payung';

  const intro =
    ctx.recipientRole === 'patient'
      ? `บริการของคุณ${escapeHtml(ctx.caregiverName)} เสร็จสมบูรณ์แล้ว — ความคิดเห็นของคุณจะช่วยให้ผู้ดูแลและผู้ใช้ท่านอื่นได้ประโยชน์`
      : `งานบริการของคุณเสร็จสมบูรณ์แล้ว ขอบคุณที่ดูแลผู้ใช้ของเราเป็นอย่างดี — ระบบจะดำเนินการเรื่องค่าตอบแทนตามขั้นตอนต่อไป`;

  const summary = formatBookingSummary({
    caregiverName:
      ctx.recipientRole === 'patient' ? ctx.caregiverName : undefined,
    dateText: ctx.dateText,
    timeText: ctx.timeText,
    serviceText: ctx.serviceText,
    totalText: ctx.totalText,
    totalLabel: ctx.totalLabel,
  });

  const bodyHtml = `
    ${titleBlock(heading, `${greeting(ctx.recipientName)} ${intro}`)}
    ${summary}
  `;

  // PYG-703: เดิม patient → /bookings/{id}/review ซึ่งไม่มี route ใน FE (404)
  //   ฟอร์มให้คะแนนอยู่ในหน้ารายละเอียดการจองอยู่แล้ว · caregiver ไปหน้างานของผู้ดูแล
  const ctaUrl = bookingDetailUrl(ctx);
  const ctaLabel =
    ctx.recipientRole === 'patient' ? 'ให้คะแนนผู้ดูแล' : 'ดูสรุปงาน';

  const text = `${plainGreeting(ctx.recipientName)}

${heading}
${
  ctx.recipientRole === 'patient'
    ? `บริการของคุณ${ctx.caregiverName} เสร็จสมบูรณ์ — ให้คะแนนเพื่อช่วยผู้ใช้ท่านอื่น`
    : 'งานบริการเสร็จสมบูรณ์ ขอบคุณ — ระบบจะดำเนินการค่าตอบแทนต่อไป'
}
${plainBookingSummary({
  caregiverName:
    ctx.recipientRole === 'patient' ? ctx.caregiverName : undefined,
  dateText: ctx.dateText,
  timeText: ctx.timeText,
  serviceText: ctx.serviceText,
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
      badge: { label: 'เสร็จสิ้น', tone: 'success' },
      secondaryLinks:
        ctx.recipientRole === 'patient'
          ? [{ label: 'จองอีกครั้ง', url: `${ctx.frontendUrl}/booking/new` }]
          : undefined,
    }),
    text,
  };
};
