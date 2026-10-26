/**
 * booking.declined (PYG-293) — แจ้ง Patient ว่าผู้ดูแลปฏิเสธคำขอ
 * Subject: "ผู้ดูแลปฏิเสธคำขอ — Payung"
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

export const bookingDeclinedTemplate: BookingTemplateFn = (
  ctx,
): EmailTemplate => {
  const subject = emailSubject('ผู้ดูแลปฏิเสธคำขอ');
  const heading = 'ผู้ดูแลไม่สามารถรับคำขอของคุณได้';
  const intro = `เราต้องเสียใจที่จะแจ้งให้ทราบว่า คุณ${escapeHtml(ctx.caregiverName)} ไม่สามารถรับงานนี้ได้ — กรุณาลองค้นหาผู้ดูแลท่านอื่นจากระบบของเรา`;

  const summary = formatBookingSummary({
    dateText: ctx.dateText,
    timeText: ctx.timeText,
    serviceText: ctx.serviceText,
    locationAddress: ctx.locationAddress,
    extraRows: ctx.declineReason
      ? [{ label: 'เหตุผล', value: ctx.declineReason }]
      : [],
  });

  const bodyHtml = `
    ${titleBlock(heading, `${greeting(ctx.recipientName)} ${intro}`)}
    ${summary}
  `;

  // PYG-703: เดิม /caregivers ซึ่งไม่มี route ใน FE (404) — หน้ารายละเอียดการจองของ patient
  //   แสดงสถานะ "ปฏิเสธแล้ว" พร้อมทางไปเลือกผู้ดูแลท่านอื่นอยู่แล้ว
  const ctaUrl = bookingDetailUrl(ctx);
  const ctaLabel = 'เลือกผู้ดูแลท่านอื่น';

  const text = `${plainGreeting(ctx.recipientName)}

${heading}
คุณ${ctx.caregiverName} ไม่สามารถรับงานนี้ได้ — ลองค้นหาผู้ดูแลท่านอื่น${ctx.declineReason ? `\n\nเหตุผล: ${ctx.declineReason}` : ''}
${plainBookingSummary({
  dateText: ctx.dateText,
  timeText: ctx.timeText,
  serviceText: ctx.serviceText,
  locationAddress: ctx.locationAddress,
})}
${ctaLabel}: ${ctaUrl}${plainTextFooter(ctx.frontendUrl)}`;

  return {
    subject,
    html: wrapHtml({
      bodyHtml,
      ctaUrl,
      ctaLabel,
      frontendUrl: ctx.frontendUrl,
      badge: { label: 'ไม่สำเร็จ', tone: 'neutral' },
    }),
    text,
  };
};
