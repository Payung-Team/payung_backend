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
import {
  wrapHtml,
  plainTextFooter,
  escapeHtml,
  emailSubject,
  greetingHtml,
  greetingText,
  HEADING_STYLE,
} from './layout';
import { summaryRow, summaryTable } from './booking/helpers';
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
  /**
   * PYG-526: "09:00 – 13:00 (4 ชม.)" — เดิม template นี้มีแค่วันที่ ไม่มีเวลาเลย
   * (ใช้กับ event ที่ไม่มี per-event template เช่น job.checked_out)
   */
  timeText?: string;
  serviceText?: string;
  amountText?: string;

  // ── ปุ่ม CTA (optional) ──
  ctaUrl?: string;
  ctaLabel?: string;
};

/** สร้างตารางรายละเอียด — คืน '' ถ้าไม่มีข้อมูลสักแถว */
function detailsTable(p: BookingEmailParams): string {
  const rows: Array<[string, string]> = [];
  if (p.caregiverName) rows.push(['ผู้ดูแล', p.caregiverName]);
  if (p.dateText) rows.push(['วันที่', p.dateText]);
  if (p.timeText) rows.push(['เวลา', p.timeText]);
  if (p.serviceText) rows.push(['บริการ', p.serviceText]);
  if (p.amountText) rows.push(['ยอดรวม', p.amountText]);
  // PYG-703: ใช้แถว/ตารางเดียวกับ per-event template (เดิมเขียน HTML ซ้ำ สีคนละชุด)
  return summaryTable(
    rows.map(([label, value]) => summaryRow(label, value)).join(''),
  );
}

/** plain-text version ของตาราง (สำหรับ email client ที่ block HTML) */
function detailsText(p: BookingEmailParams): string {
  const lines: string[] = [];
  if (p.caregiverName) lines.push(`ผู้ดูแล: ${p.caregiverName}`);
  if (p.dateText) lines.push(`วันที่: ${p.dateText}`);
  if (p.timeText) lines.push(`เวลา: ${p.timeText}`);
  if (p.serviceText) lines.push(`บริการ: ${p.serviceText}`);
  if (p.amountText) lines.push(`ยอดรวม: ${p.amountText}`);
  return lines.length ? `\n${lines.join('\n')}\n` : '';
}

/**
 * สร้าง EmailTemplate สำหรับ booking notification
 * (ใช้ heading/intro จาก notification เดียวกับ in-app เพื่อให้ข้อความตรงกัน)
 */
export function bookingNotificationTemplate(p: BookingEmailParams): EmailTemplate {
  const subject = emailSubject(p.heading);

  const bodyHtml = `
    <p>${greetingHtml(p.recipientName)}</p>
    <h2 style="${HEADING_STYLE}">${escapeHtml(p.heading)}</h2>
    <p>${escapeHtml(p.intro)}</p>
    ${detailsTable(p)}
  `;

  const text = `${greetingText(p.recipientName)}

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
