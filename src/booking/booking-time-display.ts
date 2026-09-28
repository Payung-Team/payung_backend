/**
 * การแสดงเวลาของใบจอง — PYG-526 (การ์ดแม่ PYG-490)
 *
 * ★ ทำไมต้องมีไฟล์นี้
 *   ตั้งแต่ PYG-523 ผู้ใช้ไม่ได้เลือก timeSlot เองแล้ว (BE อนุมานจากเวลาเริ่ม)
 *   ถ้ายังแสดง "ช่วงเช้า" จะไม่ตรงกับที่ผู้ใช้กรอก — จอง 11:00–15:00 แต่เห็น "ช่วงเช้า"
 *   ทุกหน้าและอีเมลจึงต้องแสดงเป็น "เริ่ม – สิ้นสุด (N ชม.)" แทน
 *
 * ★ endTime ไม่ได้เก็บในดีบี — คำนวณจาก start_time + duration_hours ทุกครั้งที่อ่าน
 *   ใบจองเก่ากับใบจองใหม่จึงได้ endTime ด้วยสูตรเดียวกัน ไม่ต้อง migrate
 *   (PYG-523 เก็บ durationHours = endTime − startTime ไว้แล้ว → บวกกลับได้ค่าเดิมเป๊ะ)
 *
 * ★ ไฟล์นี้เป็นที่เดียวที่แปลงเวลาใบจองเป็นข้อความ — BookingSummary, งานของผู้ดูแล,
 *   ฟีดกลุ่มครอบครัว, dispute, อีเมล และแจ้งเตือนในแอป เรียกจากที่นี่ทั้งหมด
 *   ถ้าจะเปลี่ยนรูปแบบ (เช่นเติม "น.") แก้ที่นี่ที่เดียว ทุกจุดเปลี่ยนตาม
 *
 * ── พื้นฐานที่ต้องรู้ ──────────────────────────────────────────────────────────
 *   bookings.start_time เป็นคอลัมน์ TIME → Prisma คืนเป็น Date 1970-01-01T09:00:00Z
 *   ค่า UTC ของ Date นั้น = เวลาไทยที่ผู้ใช้กรอก (ไม่ต้องบวกลบ timezone)
 *   bookings.duration_hours เป็น Decimal → Number() แปลงได้ทั้ง Decimal และ number
 */
import type { Prisma } from '@prisma/client';

const MINUTES_PER_DAY = 24 * 60;

/** ค่า durationHours ที่อาจมาจาก Prisma (Decimal) หรือแปลงแล้ว (number) */
type HoursValue = Prisma.Decimal | number | null | undefined;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** นาทีนับจากเที่ยงคืน → "HH:mm" (วนรอบ 24 ชม. — ดู computeEndTime) */
function minuteToHm(minute: number): string {
  const m = ((minute % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
}

/** Decimal | number → จำนวนชั่วโมงที่ใช้ได้ (> 0) หรือ null ถ้าไม่มี/ไม่ถูกต้อง */
function toPositiveHours(hours: HoursValue): number | null {
  if (hours === null || hours === undefined) return null;
  const n = Number(hours);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** start_time (Date ฐาน UTC) → "HH:mm" — undefined ถ้าไม่มีค่า */
export function formatStartTime(
  startTime: Date | null | undefined,
): string | undefined {
  if (!(startTime instanceof Date) || Number.isNaN(startTime.getTime())) {
    return undefined;
  }
  return minuteToHm(startTime.getUTCHours() * 60 + startTime.getUTCMinutes());
}

/**
 * เวลาสิ้นสุด "HH:mm" = start_time + duration_hours
 *
 * ★ ใบจองใหม่ (PYG-523) ไม่ข้ามเที่ยงคืนแน่นอน แต่ใบจองเก่าบางใบข้าม
 *   (เช่นเริ่ม 21:58 ยาว 4 ชม.) → วนรอบเป็น "01:58" แทนที่จะได้ "25:58"
 *   จำนวนชั่วโมงในวงเล็บที่แสดงคู่กันทำให้ผู้ใช้อ่านออกว่าเป็นเช้าวันถัดไป
 *
 * @returns undefined ถ้าไม่มีเวลาเริ่ม หรือจำนวนชั่วโมงไม่ถูกต้อง (≤ 0 / ไม่ใช่ตัวเลข)
 */
export function computeEndTime(
  startTime: Date | null | undefined,
  durationHours: HoursValue,
): string | undefined {
  const start = formatStartTime(startTime);
  const hours = toPositiveHours(durationHours);
  if (!start || hours === null) return undefined;
  const startMinute = startTime!.getUTCHours() * 60 + startTime!.getUTCMinutes();
  return minuteToHm(startMinute + Math.round(hours * 60));
}

/**
 * จำนวนชั่วโมง → "4 ชม." / "4.5 ชม."
 * ปัดทศนิยม 2 ตำแหน่งกันเลขลอย (เช่น 1.3333 จากใบจองเก่า) — undefined ถ้าไม่ถูกต้อง
 */
export function formatDurationHours(durationHours: HoursValue): string | undefined {
  const hours = toPositiveHours(durationHours);
  if (hours === null) return undefined;
  return `${Math.round(hours * 100) / 100} ชม.`;
}

/**
 * รูปแบบกลางของเวลาใบจอง: "09:00 – 13:00 (4 ชม.)"
 *
 * - ไม่มีเวลาเริ่ม           → undefined (ให้ผู้เรียกเลือกเองว่าจะแสดง "-" หรือซ่อนแถว)
 * - จำนวนชั่วโมงไม่ถูกต้อง   → แสดงแค่เวลาเริ่ม "09:00" ดีกว่าเดาเวลาสิ้นสุดผิด
 * - ใช้ en dash "–" มีเว้นวรรคสองข้าง ตามรูปแบบในการ์ด PYG-526
 */
export function formatBookingTimeRange(
  startTime: Date | null | undefined,
  durationHours: HoursValue,
): string | undefined {
  const start = formatStartTime(startTime);
  if (!start) return undefined;
  const end = computeEndTime(startTime, durationHours);
  const duration = formatDurationHours(durationHours);
  if (!end || !duration) return start;
  return `${start} – ${end} (${duration})`;
}
