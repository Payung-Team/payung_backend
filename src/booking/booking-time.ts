/**
 * เวลาของใบจองใหม่ — PYG-523 (การ์ดแม่ PYG-490)
 *
 * ผู้ใช้กรอกแค่ "เวลาเริ่ม + เวลาสิ้นสุด" แล้ว BE คำนวณสองค่าที่เคยให้ client ส่งมาเอง:
 *   durationHours = endTime − startTime
 *   timeSlot      = inferTimeSlot(startTime)   (ขอบเขตอยู่ที่ common/constants/time-slot.constant.ts)
 *
 * ★ ยังเก็บ durationHours / timeSlot ลงคอลัมน์เดิม ไม่ได้เพิ่ม end_time
 *   มีผู้ใช้ต่ออีกหลายจุดที่อ่าน durationHours อยู่แล้วและไม่ต้องแตะเลย: ตารางงาน /
 *   no-checkout sweeper (monitoring/booking-schedule.util.ts), QR (job-qr.service.ts),
 *   ยอดชำระ (payment.service.ts) — ใบจองเก่ากับใบจองใหม่จึงอ่านด้วยโค้ดชุดเดียวกัน
 *
 * ── ช่วงเปลี่ยนผ่าน ──────────────────────────────────────────────────────────
 *   FE ที่ยังไม่อัปเดตส่ง timeSlot + durationHours มาแบบเดิม → รับต่อไปก่อน
 *   มี endTime = แบบใหม่ (ค่า timeSlot / durationHours ที่ส่งมาด้วยถูกทิ้ง ใช้ค่าที่คำนวณเอง)
 *   ไม่มี endTime = แบบเดิม ตรวจเท่าที่เคยตรวจ + รูปแบบเวลาเริ่ม เพื่อไม่ให้ FE เก่าจองไม่ผ่าน
 *   ถอดแบบเดิมออกเมื่อ FE (PYG-525) ขึ้นแล้ว
 */
import { BadRequestException } from '@nestjs/common';
import {
  TIME_SLOTS,
  inferTimeSlot,
  type TimeSlot,
} from '../common/constants/time-slot.constant';

/** ขั้นของเวลา — สอดคล้องกับ durationHours >= 0.5 เดิม */
export const BOOKING_TIME_STEP_MINUTES = 30;
export const BOOKING_MIN_DURATION_MINUTES = 60;
export const BOOKING_MAX_DURATION_MINUTES = 12 * 60;

/**
 * เวลาสิ้นสุด "23:59" = เที่ยงคืน (จองได้ทั้งวัน — feature/booking-24h)
 *
 * ★ ทำไมเป็น 23:59 ไม่ใช่ 24:00
 *   ชั่วโมงในระบบเป็น 00–23 ("24:00" ไม่ผ่าน TIME_PATTERN และคอลัมน์ TIME) — ผู้ใช้จึงเลือก 23:59
 *   แต่คิดระยะเวลา/ราคาเป็น 24:00 → 23:00–23:59 = 1 ชม. เต็ม ไม่ใช่ 59 นาที
 *   รับเฉพาะ "23:59" พอดีเป็นเวลาสิ้นสุด — เวลาเริ่มหรือเวลาอื่นที่ไม่ลง :00 / :30 ยังไม่ผ่าน
 *   การแสดงผลกลับเป็น "23:59" อยู่ที่ computeEndTime (booking-time-display.ts)
 */
export const BOOKING_END_OF_DAY_TIME = '23:59';
export const BOOKING_END_OF_DAY_MINUTE = 24 * 60;

/** "HH:mm" หรือ "HH:mm:ss" (FE เดิมส่ง "09:00:00") — ชั่วโมง 00–23 */
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;

export interface BookingTimeInput {
  startTime: string;
  endTime?: string;
  timeSlot?: string;
  durationHours?: number;
}

export interface ResolvedBookingTime {
  timeSlot: TimeSlot;
  /** รูปแบบ "HH:mm:ss" พร้อมต่อเป็น `1970-01-01T${startTime}Z` */
  startTime: string;
  /** นาทีนับจากเที่ยงคืน — ใช้เช็คเวลาชน */
  startMinute: number;
  durationHours: number;
}

interface ParsedTime {
  minute: number;
  second: number;
}

function parseTime(value: string): ParsedTime | null {
  const match = TIME_PATTERN.exec(value.trim());
  if (!match) return null;
  return {
    minute: Number(match[1]) * 60 + Number(match[2]),
    second: match[3] ? Number(match[3]) : 0,
  };
}

function toTimeString(minute: number, second = 0): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(Math.floor(minute / 60))}:${pad(minute % 60)}:${pad(second)}`;
}

/**
 * ตรวจและแปลงเวลาของใบจอง — โยน 400 พร้อมข้อความภาษาไทยที่ผู้ใช้อ่านเข้าใจ
 *
 * ★ ต้องเรียกก่อนเขียนอะไรลง DB (createBookingRecord เรียกเป็นอย่างแรก)
 */
export function resolveBookingTime(
  input: BookingTimeInput,
): ResolvedBookingTime {
  // ของเดิม startTime เป็นแค่ @IsString() → "25:99" ผ่านไปถึง new Date() แล้วได้ Invalid Date
  const start = parseTime(input.startTime);
  if (!start) {
    throw new BadRequestException(
      'รูปแบบเวลาเริ่มไม่ถูกต้อง (ต้องเป็น HH:mm เช่น 09:00)',
    );
  }

  if (input.endTime === undefined || input.endTime === null) {
    return resolveLegacy(input, start);
  }

  const end = parseTime(input.endTime);
  if (!end) {
    throw new BadRequestException(
      'รูปแบบเวลาสิ้นสุดไม่ถูกต้อง (ต้องเป็น HH:mm เช่น 13:00)',
    );
  }
  // "23:59" (วินาที 00) = เที่ยงคืน → คิดเป็นนาทีที่ 1440 · ดู BOOKING_END_OF_DAY_TIME
  const endIsEndOfDay =
    end.minute === BOOKING_END_OF_DAY_MINUTE - 1 && end.second === 0;
  const endMinute = endIsEndOfDay ? BOOKING_END_OF_DAY_MINUTE : end.minute;

  // แบบใหม่รับแค่ขั้นละ 30 นาที — วินาทีที่ไม่ใช่ 00 ก็ถือว่าไม่ลงขั้น (ยกเว้นสิ้นสุด 23:59)
  if (
    start.second !== 0 ||
    end.second !== 0 ||
    start.minute % BOOKING_TIME_STEP_MINUTES !== 0 ||
    endMinute % BOOKING_TIME_STEP_MINUTES !== 0
  ) {
    throw new BadRequestException(
      'เวลาเริ่มและเวลาสิ้นสุดต้องลงที่ :00 หรือ :30 (สิ้นสุดเที่ยงคืนใช้ 23:59)',
    );
  }
  // ★ ไม่รับข้ามเที่ยงคืนในเฟสนี้ — การเช็คเวลาชนคิดภายในวันเดียว (bookingDate เดียว)
  //   ถ้ารับ 20:00–02:00 งานส่วนหลังเที่ยงคืนจะไม่ถูกเทียบกับนัดของวันถัดไปเลย
  //   ผลคือเวลาสิ้นสุดที่น้อยกว่าเวลาเริ่มถูกปฏิเสธด้วยข้อความเดียวกับ "สิ้นสุดก่อนเริ่ม"
  //   ช้าสุดจึงจบได้แค่เที่ยงคืน (23:59) ของวันจอง
  if (endMinute <= start.minute) {
    throw new BadRequestException(
      'เวลาสิ้นสุดต้องหลังเวลาเริ่ม และอยู่ในวันเดียวกัน',
    );
  }

  const durationMinutes = endMinute - start.minute;
  if (durationMinutes < BOOKING_MIN_DURATION_MINUTES) {
    throw new BadRequestException('ต้องจองอย่างน้อย 1 ชั่วโมง');
  }
  if (durationMinutes > BOOKING_MAX_DURATION_MINUTES) {
    throw new BadRequestException('จองได้สูงสุด 12 ชั่วโมงต่อครั้ง');
  }

  // slot ครอบ 00:00–24:00 แล้ว (time-slot.constant.ts) — เวลาเริ่มที่ parse ผ่านมี slot เสมอ
  // คงด่านนี้ไว้กันวันที่มีคนหด slot กลับ แล้วใบจองหลุดไปโดยไม่มี time_slot
  const timeSlot = inferTimeSlot(start.minute);
  if (!timeSlot) {
    throw new BadRequestException('เวลาเริ่มอยู่นอกช่วงที่เปิดให้จอง');
  }

  return {
    timeSlot,
    startTime: toTimeString(start.minute),
    startMinute: start.minute,
    durationHours: durationMinutes / 60,
  };
}

/**
 * แบบเดิม (FE ก่อน PYG-525) — ตรวจเท่าที่ DTO เคยตรวจ ไม่เพิ่มกฎใหม่
 * เพื่อไม่ให้ FE ที่ยังไม่อัปเดตจองไม่ผ่านกลางคัน (ใบจองเดิมมีเวลาเริ่มอย่าง 21:58 อยู่จริง)
 */
function resolveLegacy(
  input: BookingTimeInput,
  start: ParsedTime,
): ResolvedBookingTime {
  if (
    !input.timeSlot ||
    !(TIME_SLOTS as readonly string[]).includes(input.timeSlot)
  ) {
    throw new BadRequestException('กรุณาระบุเวลาสิ้นสุด');
  }
  // DTO เดิมบังคับ @Min(0.5) — ตอนนี้ช่องเป็น optional (แบบใหม่ไม่ส่ง) จึงต้องตรวจเองที่นี่
  if (
    typeof input.durationHours !== 'number' ||
    !Number.isFinite(input.durationHours) ||
    input.durationHours < 0.5
  ) {
    throw new BadRequestException('กรุณาระบุเวลาสิ้นสุด');
  }

  return {
    timeSlot: input.timeSlot as TimeSlot,
    startTime: toTimeString(start.minute, start.second),
    startMinute: start.minute,
    durationHours: input.durationHours,
  };
}
