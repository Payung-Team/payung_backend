/**
 * Helpers สำหรับ booking lifecycle email templates (PYG-293)
 *
 * รวม formatter ภาษาไทย + price breakdown + booking summary table
 * - ทุก dynamic string ผ่าน escapeHtml ก่อน inject เข้า HTML (กัน XSS)
 * - input ที่เป็น Decimal/Date จาก Prisma → normalize ก่อนคำนวณ
 */
import type { Prisma } from '@prisma/client';
import { escapeHtml } from '../layout';
// PYG-526: รูปแบบเวลาใบจองกลางของระบบ — อีเมลต้องแสดงเหมือนหน้าเว็บ
import { formatBookingTimeRange } from '../../../booking/booking-time-display';

// ─── Constants ──────────────────────────────────────────────────────────
const THAI_MONTHS = [
  'มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
  'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม',
];

const SERVICE_LABEL: Record<string, string> = {
  general_care: 'ดูแลทั่วไป',
  bedridden_care: 'ดูแลผู้ป่วยติดเตียง',
  physiotherapy: 'กายภาพบำบัด',
  medication: 'ดูแลเรื่องยา',
  companion: 'เพื่อนผู้สูงอายุ',
};

// ─── Primitives ─────────────────────────────────────────────────────────

/** Decimal | number | null → number (NaN ถ้า normalize ไม่ได้) */
export function toNumber(value: Prisma.Decimal | number | null | undefined): number {
  if (value === null || value === undefined) return NaN;
  if (typeof value === 'number') return value;
  if (typeof (value as Prisma.Decimal).toNumber === 'function') {
    return (value as Prisma.Decimal).toNumber();
  }
  return Number(value);
}

/** "฿1,234.50" (no decimals if integer) */
export function formatBaht(value: Prisma.Decimal | number | null | undefined): string {
  const n = toNumber(value);
  if (Number.isNaN(n)) return '-';
  return `฿${n.toLocaleString('th-TH', { maximumFractionDigits: 2 })}`;
}

/** Date → "15 กรกฎาคม 2569" (พ.ศ. = ค.ศ. + 543) — UTC เพราะ bookingDate เป็น @db.Date */
export function formatThaiDate(date: Date): string {
  const d = date.getUTCDate();
  const m = THAI_MONTHS[date.getUTCMonth()];
  const year = date.getUTCFullYear() + 543;
  return `${d} ${m} ${year}`;
}

/**
 * formatTimeRange(startTime, durationHours) → "09:00 – 13:00 (4 ชม.)"
 *
 * PYG-526: เดิมชื่อ formatTimeSlot และคืน "09:00 - 13:00 น. (4 ชม.)" ซึ่งคนละรูปแบบกับหน้าเว็บ
 *   ตอนนี้ส่งต่อให้ formatBookingTimeRange (ที่เดียวในระบบ) → อีเมล หน้าเว็บ และแจ้งเตือนในแอป
 *   แสดงเวลาเหมือนกันทุกตัวอักษร ถ้าจะเปลี่ยนรูปแบบให้แก้ที่ booking-time-display.ts
 * - startTime จาก Prisma เป็น Date object (@db.Time) — UTC components คือเวลาจริง
 * - durationHours เป็น Decimal — รองรับ 0.5/1.5 ชม.
 * - ไม่มีเวลาเริ่ม → "-" (ตารางในอีเมลต้องมีค่าเสมอ)
 */
export function formatTimeRange(
  startTime: Date | null,
  durationHours: Prisma.Decimal | number | null | undefined,
): string {
  return formatBookingTimeRange(startTime, durationHours) ?? '-';
}

/** "4.8 ★ (รีวิว 12 ครั้ง)" — null avg → "ยังไม่มีรีวิว" */
export function formatRating(avg: number | null, count: number | null | undefined): string {
  const c = count ?? 0;
  if (avg === null || avg === undefined || c === 0) return 'ยังไม่มีรีวิว';
  return `${avg.toFixed(1)} ★ (รีวิว ${c} ครั้ง)`;
}

/** booking_service_type → ป้ายไทย */
export function formatServiceType(serviceType: string): string {
  return SERVICE_LABEL[serviceType] ?? serviceType;
}

// ─── Composite ──────────────────────────────────────────────────────────

/**
 * Price breakdown สำหรับอีเมล
 *
 * ⚠️ ยอดรวม (totalText) = "ยอดที่เรียกเก็บจริง" เท่านั้น — ห้ามคำนวณ +10% จากสูตร
 *   ลูกค้าจ่าย = estimated_cost (ตรวจ live DB: payments.amount = estimated_cost ratio 1.0000)
 *   ค่าคอม 10% หักจากฝั่ง caregiver ตอน payout (PYG-330: gross − fee = net) ไม่ได้บวกจากลูกค้า
 *   → paidAmount (payments.amount) ถ้ามี, ไม่งั้น estimated_cost (เช่น ตอน booking.created)
 *
 * ⚠️ ค่าบริการ/ค่าธรรมเนียม (serviceCostText/platformFeeText): แสดงเฉพาะเมื่อมี platform_fee จริง
 *   ตอนนี้ bookings.platform_fee = NULL ทุกแถว (คอลัมน์ตาย จะเคลียร์ตอน PYG-341)
 *   → คืน undefined เพื่อให้ template ซ่อนบรรทัดนั้น (ห้ามเดาค่า / ห้ามโชว์ ฿0.00)
 *
 * @param estimatedCost  ราคาบริการโดยประมาณ (บาท)
 * @param platformFee    ค่าธรรมเนียมจาก DB — NULL = ไม่มีข้อมูลจริง → ไม่แสดง breakdown
 * @param paidAmount     payments.amount ถ้ามี (ยอดที่เรียกเก็บจริง) — override ยอดรวม
 */
export function formatPriceBreakdown(
  estimatedCost: Prisma.Decimal | number | null | undefined,
  platformFee: Prisma.Decimal | number | null | undefined,
  paidAmount?: Prisma.Decimal | number | null | undefined,
): { serviceCostText?: string; platformFeeText?: string; totalText: string } {
  // ยอดรวม = ยอดที่เรียกเก็บจริง (ไม่ ×1.1) — payments.amount มาก่อน, fallback estimated_cost
  const totalText = formatBaht(paidAmount ?? estimatedCost);

  // ไม่มี platform_fee จริง → ไม่แสดงบรรทัดค่าบริการ/ค่าธรรมเนียม (ตอนนี้ NULL ทุกแถว)
  if (Number.isNaN(toNumber(platformFee))) {
    return { totalText };
  }

  // มี platform_fee จริง (future: หลัง PYG-341) → แสดงแยกบรรทัดจากค่าจริง
  return {
    serviceCostText: formatBaht(estimatedCost),
    platformFeeText: formatBaht(platformFee),
    totalText,
  };
}

/** ── HTML row builder (escape ภายใน) ── */
export function summaryRow(label: string, value: string, opts?: { bold?: boolean }): string {
  const valStyle = opts?.bold
    ? 'color:#1A2422; font-size:14px; font-weight:700; text-align:right;'
    : 'color:#1A2422; font-size:14px; font-weight:600; text-align:right;';
  return `
    <tr>
      <td style="padding:8px 0; color:#6B7773; font-size:14px;">${escapeHtml(label)}</td>
      <td style="padding:8px 0; ${valStyle}">${escapeHtml(value)}</td>
    </tr>`;
}

/** wrap rows ใน table — สำหรับใช้กับ summaryRow */
export function summaryTable(rowsHtml: string): string {
  if (!rowsHtml.trim()) return '';
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
           style="margin:16px 0; border:1px solid #E5E7E9; border-radius:8px; padding:8px 16px;">
      ${rowsHtml}
    </table>`;
}

/**
 * formatBookingSummary — render ตารางรายละเอียด booking มาตรฐาน
 * (ใช้กับ template ที่ไม่ต้อง custom row — เช่น booking_created, booking_confirmed)
 */
export function formatBookingSummary(args: {
  caregiverName?: string;
  ratingText?: string;
  dateText?: string;
  timeText?: string;
  serviceText?: string;
  locationAddress?: string;
  totalText?: string;
}): string {
  const rows: string[] = [];
  if (args.caregiverName) rows.push(summaryRow('ผู้ดูแล', args.caregiverName));
  if (args.ratingText) rows.push(summaryRow('คะแนน', args.ratingText));
  if (args.dateText) rows.push(summaryRow('วันที่', args.dateText));
  if (args.timeText) rows.push(summaryRow('เวลา', args.timeText));
  if (args.serviceText) rows.push(summaryRow('บริการ', args.serviceText));
  if (args.locationAddress) rows.push(summaryRow('สถานที่', args.locationAddress));
  if (args.totalText) rows.push(summaryRow('ยอดรวม', args.totalText, { bold: true }));
  return summaryTable(rows.join(''));
}

/** plain-text summary (สำหรับ text/plain ของอีเมล) */
export function plainBookingSummary(args: {
  caregiverName?: string;
  ratingText?: string;
  dateText?: string;
  timeText?: string;
  serviceText?: string;
  locationAddress?: string;
  totalText?: string;
}): string {
  const lines: string[] = [];
  if (args.caregiverName) lines.push(`ผู้ดูแล: ${args.caregiverName}`);
  if (args.ratingText) lines.push(`คะแนน: ${args.ratingText}`);
  if (args.dateText) lines.push(`วันที่: ${args.dateText}`);
  if (args.timeText) lines.push(`เวลา: ${args.timeText}`);
  if (args.serviceText) lines.push(`บริการ: ${args.serviceText}`);
  if (args.locationAddress) lines.push(`สถานที่: ${args.locationAddress}`);
  if (args.totalText) lines.push(`ยอดรวม: ${args.totalText}`);
  return lines.length ? `\n${lines.join('\n')}\n` : '';
}

/** "สวัสดีค่ะ คุณ{name}" (escape ชื่อ) */
export function greeting(name: string | null | undefined): string {
  return name ? `สวัสดีค่ะ คุณ${escapeHtml(name)}` : 'สวัสดีค่ะ คุณผู้ใช้';
}

/** plain-text greeting (ไม่ escape เพราะไม่ render เป็น HTML) */
export function plainGreeting(name: string | null | undefined): string {
  return name ? `สวัสดีค่ะ คุณ${name}` : 'สวัสดีค่ะ คุณผู้ใช้';
}
