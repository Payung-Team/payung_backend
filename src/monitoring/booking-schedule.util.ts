/**
 * เวลาของ booking 1 ใบ — แปลง "วันที่ + เวลาเริ่ม + ชั่วโมงที่จอง" ให้เป็นเวลาจริง
 *
 * ★ ทำไมต้องแยกออกมาเป็นไฟล์กลาง (PYG-434)
 *   ตรรกะนี้เคยอยู่เป็น private method ใน monitoring.service.ts ที่เดียว
 *   พอ PYG-434 (QR) ต้องคำนวณช่วงเวลาที่ QR ใช้ได้ ก็ต้องใช้สูตรเดียวกันเป๊ะ ๆ
 *   ถ้าก๊อปไปไว้อีกที่ วันหนึ่งที่แก้สูตร (เช่นเปลี่ยน timezone) แล้วแก้ไม่ครบ
 *   ระบบเช็คอินกับ QR จะตัดสิน "เวลานัด" ไม่ตรงกัน → QR หมดอายุทั้งที่ยังไม่ถึงเวลา
 *   ซึ่งเป็นบั๊กที่หาสาเหตุยากมาก เพราะทั้งสองฝั่ง "ดูเหมือนถูก" เมื่ออ่านแยกกัน
 *
 * ★★ พื้นฐานที่ต้องรู้ก่อนแก้ไฟล์นี้ ★★
 *   สองคอลัมน์ในดีบีถูกอ่านกลับมาเป็น Date ที่ฐาน UTC เสมอ:
 *     bookings.booking_date (DATE)     → 2026-06-13T00:00:00Z
 *     bookings.start_time   (TIME)     → 1970-01-01T09:00:00Z
 *   ความหมายจริงคือ "9 โมงเช้า เวลาไทย" ไม่ใช่ 9 โมง UTC
 *   → ต้องลบ 7 ชม. เพื่อให้ได้ "จุดเวลาจริง" บนไทม์ไลน์
 *   (ไทยเป็น UTC+7 คงที่ ไม่มี DST จึงบวกลบตรง ๆ ได้ ไม่ต้องพึ่ง library)
 */
import { Prisma } from '@prisma/client';

/** ประเทศไทย = UTC+7 ตลอดปี */
const THAILAND_UTC_OFFSET_MS = 7 * 60 * 60 * 1000;

/**
 * เวลาที่ "นัดเริ่มงาน" จริง ๆ บนไทม์ไลน์
 *
 * @param bookingDate คอลัมน์ booking_date (DATE)
 * @param startTime   คอลัมน์ start_time (TIME) — null ได้ ถือว่าเที่ยงคืน
 */
export function scheduledStartOf(
  bookingDate: Date,
  startTime: Date | null,
): Date {
  const utcMidnight = Date.UTC(
    bookingDate.getUTCFullYear(),
    bookingDate.getUTCMonth(),
    bookingDate.getUTCDate(),
    startTime ? startTime.getUTCHours() : 0,
    startTime ? startTime.getUTCMinutes() : 0,
    startTime ? startTime.getUTCSeconds() : 0,
  );
  return new Date(utcMidnight - THAILAND_UTC_OFFSET_MS);
}

/**
 * เวลาที่ "นัดเลิกงาน" — เวลาเริ่ม + จำนวนชั่วโมงที่จอง
 *
 * durationHours เป็น Decimal ของ Prisma (จองครึ่งชั่วโมงได้ เช่น 2.5)
 * Number() รับได้ทั้ง Decimal และ number จึงไม่ต้องแยกเคส
 */
export function scheduledEndOf(
  bookingDate: Date,
  startTime: Date | null,
  durationHours: Prisma.Decimal | number,
): Date {
  const start = scheduledStartOf(bookingDate, startTime);
  const durationMs = Number(durationHours) * 60 * 60 * 1000;
  return new Date(start.getTime() + durationMs);
}
