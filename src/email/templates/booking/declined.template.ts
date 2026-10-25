/**
 * booking.declined (PYG-293) — แจ้ง Patient ว่าผู้ดูแลปฏิเสธคำขอ
 * Subject: "ผู้ดูแลปฏิเสธคำขอ — Payung"
 */
import {
  wrapHtml,
  plainTextFooter,
  escapeHtml,
  emailSubject,
  HEADING_STYLE,
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

  const reasonBlock = ctx.declineReason
    ? `
      <div style="background:#fff5f5; border-left:4px solid #e53935; padding:12px 16px; margin:16px 0;">
        <p style="margin:0; font-weight:600; color:#c62828;">เหตุผล:</p>
        <p style="margin:8px 0 0;">${escapeHtml(ctx.declineReason)}</p>
      </div>`
    : '';

  const summary = formatBookingSummary({
    dateText: ctx.dateText,
    timeText: ctx.timeText,
    serviceText: ctx.serviceText,
    locationAddress: ctx.locationAddress,
  });

  const bodyHtml = `
    <p>${greeting(ctx.recipientName)}</p>
    <h2 style="${HEADING_STYLE}">${escapeHtml(heading)}</h2>
    <p>${intro}</p>
    ${reasonBlock}
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
    }),
    text,
  };
};
