/**
 * Booking Email Templates (PYG-292)
 *
 * 1 template แบบ parameterized ใช้กับทุก booking/payment notification ที่ต้องส่งอีเมล
 * - โครงสร้างตาม Figma "Email Template — booking_accepted":
 *   header (Payung) → heading → greeting + เนื้อหา → ตารางรายละเอียด → ปุ่ม CTA → footer
 * - reuse wrapHtml/escapeHtml จาก layout.ts (header/footer/ปุ่ม เหมือน KYC email)
 *
 * ทำไม template เดียวพอ?
 * - ทุก event ใช้ layout เดียวกัน ต่างกันแค่ heading/เนื้อหา/ตาราง/ปุ่ม → ส่งเป็น param
 * - DRY: แก้ดีไซน์ที่เดียว เปลี่ยนทุกอีเมล booking
 */
import { wrapHtml, plainTextFooter, escapeHtml } from './layout';
import type { EmailTemplate } from './kyc.templates';

/** ค่าที่ใช้สร้างอีเมล booking notification */
export type BookingEmailParams = {
  /** ชื่อผู้รับ (สำหรับ greeting) — null = "คุณผู้ใช้" */
  recipientName: string | null;
  /** หัวข้อ = title ของ notification (เช่น "ผู้ดูแลรับคำขอแล้ว") */
  heading: string;
  /** เนื้อหา = body ของ notification */
  intro: string;
  /** base URL ของ frontend (สำหรับ CTA + unsubscribe) */
  frontendUrl: string;

  // ── รายละเอียด (optional) — มีค่าตัวไหนค่อยแสดงแถวนั้นในตาราง ──
  caregiverName?: string;
  dateText?: string;
  serviceText?: string;
  amountText?: string;

  // ── ปุ่ม CTA (optional) ──
  ctaUrl?: string;
  ctaLabel?: string;
};

/** greeting — escape ชื่อกัน XSS (ชื่อมาจาก user-supplied display name) */
function greeting(name: string | null): string {
  return name ? `สวัสดีคุณ ${escapeHtml(name)}` : 'สวัสดีคุณผู้ใช้';
}

/** สร้างตารางรายละเอียด — คืน '' ถ้าไม่มีข้อมูลสักแถว */
function detailsTable(p: BookingEmailParams): string {
  const rows: Array<[string, string]> = [];
  if (p.caregiverName) rows.push(['ผู้ดูแล', p.caregiverName]);
  if (p.dateText) rows.push(['วันที่', p.dateText]);
  if (p.serviceText) rows.push(['บริการ', p.serviceText]);
  if (p.amountText) rows.push(['ยอดรวม', p.amountText]);
  if (rows.length === 0) return '';

  const trs = rows
    .map(
      ([label, value]) => `
        <tr>
          <td style="padding:8px 0; color:#6B7773; font-size:14px;">${escapeHtml(label)}</td>
          <td style="padding:8px 0; color:#1A2422; font-size:14px; font-weight:600; text-align:right;">${escapeHtml(value)}</td>
        </tr>`,
    )
    .join('');

  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
           style="margin:16px 0; border:1px solid #E5E7E9; border-radius:8px; padding:8px 16px;">
      ${trs}
    </table>`;
}

/** plain-text version ของตาราง (สำหรับ email client ที่ block HTML) */
function detailsText(p: BookingEmailParams): string {
  const lines: string[] = [];
  if (p.caregiverName) lines.push(`ผู้ดูแล: ${p.caregiverName}`);
  if (p.dateText) lines.push(`วันที่: ${p.dateText}`);
  if (p.serviceText) lines.push(`บริการ: ${p.serviceText}`);
  if (p.amountText) lines.push(`ยอดรวม: ${p.amountText}`);
  return lines.length ? `\n${lines.join('\n')}\n` : '';
}

/**
 * สร้าง EmailTemplate สำหรับ booking notification
 * (ใช้ heading/intro จาก notification เดียวกับ in-app เพื่อให้ข้อความตรงกัน)
 */
export function bookingNotificationTemplate(p: BookingEmailParams): EmailTemplate {
  const subject = `${p.heading} — Payung`;

  const bodyHtml = `
    <p>${greeting(p.recipientName)},</p>
    <h2 style="font-size:20px; color:#1A2422; margin:8px 0 12px;">${escapeHtml(p.heading)}</h2>
    <p>${escapeHtml(p.intro)}</p>
    ${detailsTable(p)}
  `;

  const text = `${greeting(p.recipientName).replace(/<[^>]+>/g, '')},

${p.heading}
${p.intro}
${detailsText(p)}${p.ctaUrl ? `\n${p.ctaLabel ?? 'เปิดแอป Payung'}: ${p.ctaUrl}` : ''}${plainTextFooter(p.frontendUrl)}`;

  return {
    subject,
    html: wrapHtml({
      bodyHtml,
      ctaUrl: p.ctaUrl,
      ctaLabel: p.ctaLabel,
      frontendUrl: p.frontendUrl,
    }),
    text,
  };
}
