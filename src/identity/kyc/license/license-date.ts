/**
 * วันหมดอายุของใบประกอบฯ — เทียบด้วยเขตเวลา Asia/Bangkok (UTC+7 ไม่มี DST) อย่างชัดเจน
 * ไม่พึ่งเขตเวลาของเครื่อง server (E3/E4)
 *
 * ค่าที่เก็บใน kyc_documents.expires_at = สิ้นวัน (23:59:59.999 +07:00) ของวันหมดอายุ (PYG-586)
 */
const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** วันที่ตามปฏิทินไทยของ instant นี้ เป็นเลขวัน (ใช้เทียบกันได้โดยไม่ยุ่งกับ timezone) */
export function bangkokDayNumber(instant: Date): number {
  return Math.floor((instant.getTime() + BANGKOK_OFFSET_MS) / DAY_MS);
}

/** ปฏิทินไทยของ instant → 'YYYY-MM-DD' */
export function bangkokDateString(instant: Date): string {
  return new Date(instant.getTime() + BANGKOK_OFFSET_MS).toISOString().slice(0, 10);
}

/** วันหมดอายุเป็น "วันในอนาคต" ตามปฏิทินไทยหรือไม่ — วันนี้ถือว่าไม่ใช่ */
export function isBangkokDateInFuture(expiry: Date, now: Date): boolean {
  return bangkokDayNumber(expiry) > bangkokDayNumber(now);
}

/**
 * instant ที่ client ส่งมา → สิ้นวันตามเวลาไทยของวันที่นั้น
 * รับได้ทั้ง 'YYYY-MM-DD' (parse เป็น 00:00Z) และ timestamp เต็ม — ใช้วันที่ตามปฏิทินไทยของ instant นั้น
 */
export function toBangkokEndOfDay(input: Date): Date {
  const day = bangkokDayNumber(input);
  return new Date((day + 1) * DAY_MS - BANGKOK_OFFSET_MS - 1);
}
