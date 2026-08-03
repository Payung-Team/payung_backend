/**
 * ค่าคงที่ของระบบ proof-of-work (PYG-351 / PYG-352)
 *
 * ทุกค่าอ่านจาก ENV ได้ แต่มี default ที่ตรงกับดีไซน์ใน Figma เสมอ
 * (วงกลมสองวงบนแผนที่หน้าเช็คอินเขียนไว้ชัด ๆ ว่า 200 ม. กับ 500 ม.)
 *
 * ⚠ อ่านตรงนี้ก่อนแก้ค่า:
 *   WARN_RADIUS_M กับ GPS_ACCURACY_TRUST_M บังเอิญเป็น 200 เท่ากัน แต่ "คนละความหมาย"
 *   - WARN_RADIUS_M        = ไกลจากจุดงานแค่ไหนถึงจะเตือนใน UI
 *   - GPS_ACCURACY_TRUST_M = สัญญาณตำแหน่งมั่วแค่ไหนถึงจะเลิกเชื่อค่าระยะทาง
 *   อย่ารวมสองค่านี้เป็นตัวเดียวกันเด็ดขาด เพราะวันหนึ่งมันจะต้องแยกกันเดิน
 */

/** อ่านตัวเลขจาก ENV ถ้าไม่มีหรือไม่ใช่ตัวเลข → ใช้ค่า default */
function envInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** ≤ 200 ม. = ปกติ ไม่มีอะไรเกิดขึ้น */
export const WARN_RADIUS_M = envInt('WARN_RADIUS_M', 200);

/**
 * > 500 ม. = ติดธง 'out_of_radius'
 * ระหว่าง 200–500 ม. = เตือนใน UI เฉย ๆ **ไม่ติดธง**
 * (GPS ดริฟต์ 300 ม. ในตึกคอนกรีตเป็นเรื่องปกติมาก)
 */
export const VERDICT_RADIUS_M = envInt('VERDICT_RADIUS_M', 500);

/**
 * ถ้า accuracy_m เกินค่านี้ = สัญญาณตำแหน่งเชื่อไม่ได้ → **ไม่ติดธงใด ๆ ทั้งสิ้น**
 * เกิดจากการที่โปรดักต์เปลี่ยนเป็น web app: เบราว์เซอร์บนเดสก์ท็อปไม่มีชิป GPS
 * เดาตำแหน่งจาก Wi-Fi/IP คลาดเคลื่อนได้เป็นกิโลเมตร
 * ถ้าไม่มีกฎข้อนี้ ผู้ดูแลที่ทำงานจริงเกือบทุกคนจะโดนธงหมด
 */
export const GPS_ACCURACY_TRUST_M = envInt('GPS_ACCURACY_TRUST_M', 200);

/** มาก่อนเวลานัดได้ถึง 60 นาที โดยไม่ถือว่าผิด — มาเช้าไม่ใช่ความผิด */
export const EARLY_GRACE_MIN = envInt('EARLY_GRACE_MIN', 60);

/** สายเกิน 30 นาทีจากเวลานัด → ติดธง 'out_of_window' */
export const LATE_VERDICT_MIN = envInt('LATE_VERDICT_MIN', 30);

/** นาฬิกาเครื่องต่างจากเซิร์ฟเวอร์เกินกี่นาทีถึงจะถือว่าผิดปกติ */
export const CLOCK_ANOMALY_TOLERANCE_MIN = envInt(
  'CLOCK_ANOMALY_TOLERANCE_MIN',
  10,
);

/** ชื่อ bucket สำหรับรูปหลักฐาน (private) — path: {bookingId}/{eventType}-{timestamp}.jpg */
export const JOB_EVIDENCE_BUCKET = 'job-evidence';

/** อายุของ signed URL (วินาที) — ตามแพตเทิร์นเดิมของโปรเจกต์คือ 1 ชม. */
export const SIGNED_URL_TTL_SEC = 3600;

/**
 * เหตุผลทั้งหมดที่ทำให้งานต้องถูกรีวิว
 * ค่าพวกนี้ถูกเขียนลง bookings.review_reasons และ FE เอาไปแปลงเป็น chip ภาษาไทย
 */
export const REVIEW_REASON = {
  /** เช็คอิน/เช็คเอาท์ไกลจากจุดงานเกิน VERDICT_RADIUS_M */
  OUT_OF_RADIUS: 'out_of_radius',
  /** เช็คอินนอกกรอบเวลาที่ยอมรับได้ */
  OUT_OF_WINDOW: 'out_of_window',
  /** นาฬิกาเครื่อง client ต่างจากเซิร์ฟเวอร์มากผิดปกติ */
  CLOCK_ANOMALY: 'clock_anomaly',
} as const;

export type ReviewReason = (typeof REVIEW_REASON)[keyof typeof REVIEW_REASON];

/** ประเภทของ job event */
export const JOB_EVENT_TYPE = {
  CHECK_IN: 'check_in',
  CHECK_OUT: 'check_out',
} as const;

/** สถานะ booking ที่โมดูลนี้เกี่ยวข้อง (bookings.status เป็น TEXT) */
export const BOOKING_STATUS = {
  CONFIRMED: 'confirmed',
  /** กำลังปฏิบัติงาน — ตั้งตอนเช็คอิน */
  IN_PROGRESS: 'in_progress',
} as const;

/** ที่มาของ job event */
export const JOB_EVENT_SOURCE = {
  /** ผู้ดูแลกดเอง */
  CAREGIVER: 'caregiver',
  /** cron กวาดปิดงานให้ (PYG-359) — verdict='valid' ไม่รับ source นี้ */
  SYSTEM: 'system',
} as const;

/** timezone ที่ใช้ตัดสินว่า "วันนี้" คือวันไหน */
export const BUSINESS_TIMEZONE = 'Asia/Bangkok';
