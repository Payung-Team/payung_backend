/**
 * ค่าคงที่ของระบบ QR check-in/out (PYG-434 · การ์ดแม่ PYG-433)
 *
 * ทุกค่าอ่านจาก ENV ได้ แต่มี default ที่ใช้งานได้จริงเสมอ
 * (แพตเทิร์นเดียวกับ monitoring.constants.ts — ใช้ envInt ตัวเดียวกันด้วย)
 *
 * ⚠ ไฟล์นี้กินพื้นที่ของการ์ด PYG-441 ([Config] QR settings) ไปบางส่วน
 *   เพราะ PYG-434 คำนวณ valid_from / valid_until ไม่ได้เลยถ้าไม่มีค่าพวกนี้
 *   เมื่อ Sam ทำ PYG-441 ให้มา "รีวิว/ปรับค่า" ในไฟล์นี้ต่อได้เลย ไม่ต้องสร้างไฟล์ใหม่
 */
import { envInt } from '../monitoring.constants';

// ─── 1. ช่วงเวลาที่ QR ใช้ได้ ───────────────────────────────────────────────

/**
 * เปิดให้สแกนได้ล่วงหน้ากี่นาทีก่อนเวลานัดเริ่มงาน
 *
 * ทำไมต้องมี: ผู้ดูแลมาถึงก่อนเวลาเป็นเรื่องปกติ (และเป็นเรื่องดีด้วย)
 * ถ้า QR เพิ่งเปิดตอนเวลานัดพอดี คนที่มาถึงก่อนจะยืนรอหน้าบ้านลูกค้าเฉย ๆ
 *
 * ★ ตั้งใจให้เท่ากับ EARLY_GRACE_MIN (60 นาที) ของระบบเช็คอินเดิม
 *   ถ้าตั้งให้แคบกว่า จะเกิดสถานการณ์ประหลาด: ระบบบอกว่าเช็คอินได้แล้ว
 *   แต่ QR ยังไม่เปิด → ผู้ดูแลเห็นว่า "สแกนไม่ผ่าน" ทั้งที่ไม่ได้ทำอะไรผิด
 *   ถ้าจะแก้ค่านี้ ให้ดู EARLY_GRACE_MIN ประกอบเสมอ
 */
export const QR_VALID_FROM_OFFSET_MIN = envInt('QR_VALID_FROM_OFFSET_MIN', 60);

/**
 * ยังสแกนได้อีกกี่นาทีหลังเวลานัดเลิกงาน
 *
 * 120 นาที (2 ชม.) เพราะงานดูแลผู้สูงอายุเลิกช้ากว่านัดเป็นเรื่องปกติมาก
 * (ลูกค้าคุยต่อ / รอญาติกลับบ้าน / งานยังไม่เสร็จ)
 * ถ้าตั้งแคบเกินไป ผู้ดูแลจะเช็คเอาท์ไม่ได้แล้วต้องให้แอดมินปิดงานให้ทุกใบ
 */
export const QR_VALID_UNTIL_GRACE_MIN = envInt('QR_VALID_UNTIL_GRACE_MIN', 120);

// ─── 2. ความปลอดภัยของ token ────────────────────────────────────────────────

/**
 * ชื่อ ENV ที่เก็บกุญแจลับของเซิร์ฟเวอร์ (ต้องยาว ≥ 32 ตัวอักษร)
 *
 * ★★ กุญแจนี้คือสิ่งเดียวที่กันไม่ให้คนปลอม QR ★★
 *    - ห้าม commit ลง git เด็ดขาด (อยู่ใน .env เท่านั้น)
 *    - ห้ามส่งไปฝั่ง frontend ไม่ว่ากรณีใด
 *    - ถ้ากุญแจหลุด ต้องเปลี่ยนค่าใหม่ ซึ่งจะทำให้ QR ของ booking ทุกใบเปลี่ยนตาม
 *      (ไม่ต้องแก้ดีบี เพราะ token ถูกคำนวณใหม่ทุกครั้งอยู่แล้ว — ดู job-qr.service.ts)
 */
export const QR_TOKEN_SECRET_ENV = 'QR_TOKEN_SECRET';

/** กุญแจสั้นกว่านี้ถือว่าอ่อนเกินไป → ระบบจะไม่ยอมใช้ */
export const QR_TOKEN_SECRET_MIN_LENGTH = 32;

/**
 * "คำนำหน้า" ที่ใส่ลงไปตอนคำนวณ token (domain separation)
 *
 * ทำไมต้องมี: วันหนึ่งเราอาจใช้ QR_TOKEN_SECRET ตัวเดียวกันไปเซ็นอย่างอื่นด้วย
 * ถ้าไม่มีคำนำหน้าแยกกัน token ของคนละเรื่องที่บังเอิญมี id เหมือนกันจะออกมาเท่ากัน
 * มี v1 ต่อท้ายไว้เผื่อวันหนึ่งเปลี่ยนสูตร จะได้ออก v2 โดยไม่ชนของเดิม
 */
export const QR_TOKEN_DOMAIN = 'payung:jobqr:v1';

/**
 * PYG-435 จะใช้ค่านี้: true = 1 action สแกนได้ครั้งเดียว (สแกนซ้ำ = ปฏิเสธ)
 *
 * ⚠ การ์ดนี้ (PYG-434) "ไม่ได้ใช้" ค่านี้เลย ใส่ไว้ให้ครบชุดตั้งแต่ตอนนี้
 *   เพื่อให้คนทำ PYG-435 หยิบไปใช้ได้ทันทีโดยไม่ต้องมาเพิ่ม ENV ใหม่กลางคัน
 */
export const QR_SINGLE_USE_PER_ACTION =
  (process.env.QR_SINGLE_USE_PER_ACTION ?? 'true').toLowerCase() !== 'false';

// ─── 3. สถานะของใบ QR ───────────────────────────────────────────────────────

/**
 * สถานะของ job_sessions.status
 *
 * ⚠ ค่าพวกนี้ต้องตรงกับ CHECK "job_sessions_status_check" ในไฟล์ migration เป๊ะ ๆ
 *   (prisma/migrations/20260828000000_add_job_sessions/migration.sql)
 *   ถ้าเพิ่มค่าใหม่ที่นี่อย่างเดียว โค้ดจะ compile ผ่านแต่ INSERT จะพังตอน runtime
 *
 * ★ เดินหน้าทางเดียว: PENDING → CHECKED_IN → CHECKED_OUT
 *   ตัว QR ไม่ได้บอกว่าจะทำ action ไหน — สถานะปัจจุบันเป็นตัวตัดสิน (PYG-435)
 *
 * ★ ไม่มี CANCELLED โดยตั้งใจ — "งานถูกยกเลิกไหม" อ่านจาก bookings.status ที่เดียว
 */
export const JOB_SESSION_STATUS = {
  /** เพิ่งสร้าง ยังไม่มีใครสแกน → สแกนครั้งต่อไปคือ "เช็คอิน" */
  PENDING: 'PENDING',
  /** เช็คอินแล้ว กำลังทำงาน → สแกนครั้งต่อไปคือ "เช็คเอาท์" */
  CHECKED_IN: 'CHECKED_IN',
  /** ปิดงานแล้ว → สแกนอีกไม่ได้ */
  CHECKED_OUT: 'CHECKED_OUT',
} as const;

export type JobSessionStatus =
  (typeof JOB_SESSION_STATUS)[keyof typeof JOB_SESSION_STATUS];

/**
 * สถานะ booking ที่ทำให้ QR "ตาย" ทันที
 *
 * bookings.status เป็น TEXT (ไม่ใช่ PG enum) จึงต้องรวมค่าไว้ที่นี่
 * ให้ TypeScript ช่วยจับคำสะกดผิดแทนที่จะไปเจอตอน runtime
 */
export const QR_DEAD_BOOKING_STATUSES = ['cancelled', 'rejected'] as const;

// ─── 4. การสแกน (PYG-435) ───────────────────────────────────────────────────

/**
 * เว้นระยะขั้นต่ำระหว่างสอง action (วินาที) — ยาแก้ "สแกนรัว 2 ครั้ง"
 *
 * ปัญหาจริงที่ค่านี้แก้: ผู้ดูแลจ่อกล้องค้างไว้ที่ QR แล้ว scanner ของ browser
 * ยิง mutation ซ้ำติด ๆ กัน ครั้งแรกได้ CHECK_IN ครั้งที่สองเห็นสถานะเป็น
 * CHECKED_IN แล้ว จึงกลายเป็น CHECK_OUT ทันที = งานเปิดแล้วปิดใน 1 วินาที
 * (ระบบเดิมไม่กันเคสนี้ มันแค่ติดธง short_duration แล้วปิดงานให้จริง ๆ)
 *
 * 60 วินาทีเลือกจาก: ไม่มีงานดูแลผู้สูงอายุใบไหนใช้เวลาน้อยกว่านี้
 * แต่ก็สั้นพอที่คนสแกนพลาดจริง ๆ จะรอไหว
 *
 * ⚠ QA (PYG-440) ตั้งเป็น 0 ได้ เพื่อรันเทสเช็คอิน→เช็คเอาท์รวดเดียว
 */
export const QR_MIN_SECONDS_BETWEEN_ACTIONS = envInt(
  'QR_MIN_SECONDS_BETWEEN_ACTIONS',
  60,
);

/**
 * action ที่การสแกนครั้งนั้น "พยายามจะทำ"
 *
 * ★ ตัว QR ไม่ได้บอกว่าจะทำอะไร — สถานะปัจจุบันของ session เป็นตัวตัดสิน
 *   PENDING → CHECK_IN, CHECKED_IN → CHECK_OUT, CHECKED_OUT → ไม่เหลือ action
 *   (หลักการนี้มาจากการ์ดแม่ PYG-433 ตรง ๆ)
 *
 * ⚠ ค่าต้องตรงกับ CHECK "job_scan_events_action_check" ในไฟล์ migration เป๊ะ ๆ
 */
export const SCAN_ACTION = {
  CHECK_IN: 'CHECK_IN',
  CHECK_OUT: 'CHECK_OUT',
  /** ยังไม่ทันรู้ว่าจะทำอะไร (หา session ไม่เจอ / งานถูกยกเลิก) */
  NONE: 'NONE',
} as const;

export type ScanActionCode = (typeof SCAN_ACTION)[keyof typeof SCAN_ACTION];

/**
 * รหัสผลลัพธ์ของการสแกน 1 ครั้ง
 *
 * ★★ นี่คือ "สัญญา" ระหว่าง BE ↔ FE (PYG-438) ↔ QA (PYG-440) ★★
 *    FE แปลงรหัสพวกนี้เป็นหน้าจอคนละแบบ (ลองใหม่ / ติดต่อแอดมิน / กลับหน้างาน)
 *    ห้ามเปลี่ยนชื่อรหัสเดิมโดยไม่บอกทั้งสองฝ่าย และห้ามเพิ่มรหัสใหม่
 *    โดยไม่แก้ CHECK "job_scan_events_result_check" ในดีบีพร้อมกัน
 */
export const SCAN_RESULT = {
  /** สแกนผ่าน เช็คอิน/เช็คเอาท์สำเร็จ */
  SUCCESS: 'SUCCESS',
  /** token ไม่ตรงกับ session ใดเลย — QR ปลอม, QR ของระบบอื่น, หรืออ่านผิด */
  TOKEN_NOT_FOUND: 'TOKEN_NOT_FOUND',
  /** บัญชีที่สแกนไม่มีโปรไฟล์ผู้ดูแล (ข้อมูลผิดปกติ — role ผ่าน guard มาแล้ว) */
  NOT_A_CAREGIVER: 'NOT_A_CAREGIVER',
  /** เป็นผู้ดูแล แต่ไม่ใช่คนที่รับงานใบนี้ — ครอบคลุม "caregiver ถูกเปลี่ยนกลางคัน" ด้วย */
  WRONG_CAREGIVER: 'WRONG_CAREGIVER',
  /** งานถูกยกเลิก / ถูกปฏิเสธไปแล้ว */
  BOOKING_INACTIVE: 'BOOKING_INACTIVE',
  /** สแกนนอกช่วง valid_from..valid_until */
  OUT_OF_WINDOW: 'OUT_OF_WINDOW',
  /** session เป็น CHECKED_OUT แล้ว = สแกนครั้งที่สาม */
  ALREADY_COMPLETED: 'ALREADY_COMPLETED',
  /** สแกนถี่เกิน QR_MIN_SECONDS_BETWEEN_ACTIONS */
  TOO_SOON: 'TOO_SOON',
  /** สแกนพร้อมกันสองครั้ง แล้วครั้งนี้เป็นฝ่ายแพ้ (งานถูกทำไปแล้วโดยอีกรีเควสต์) */
  DUPLICATE: 'DUPLICATE',
  /** ลำดับไม่ถูกต้อง เช่น จะเช็คเอาท์ทั้งที่ยังไม่มีหลักฐานเช็คอิน */
  WRONG_SEQUENCE: 'WRONG_SEQUENCE',
  /** งานยังไม่พร้อม — ยังไม่ถึงวัน / ยังไม่จ่ายเงิน / สถานะไม่ใช่ confirmed */
  JOB_NOT_READY: 'JOB_NOT_READY',
} as const;

export type ScanResultCode = (typeof SCAN_RESULT)[keyof typeof SCAN_RESULT];

/**
 * ข้อความภาษาไทยที่ผู้ดูแลเห็นบนหน้าจอ — ที่เดียวในระบบ
 *
 * ทำไมต้องรวมไว้ที่นี่แทนที่จะเขียนกระจายในโค้ด:
 *   1. ข้อความเดียวกันถูกเก็บลง job_scan_events.reason ด้วย (แอดมินอ่านย้อนหลังได้)
 *   2. Design (PYG-439) ระบุ TH/EN — พอถึงวันทำ EN จะเพิ่มอีกชุดที่นี่ที่เดียว
 *
 * ★ ห้ามใส่ศัพท์เทคนิคหรือรหัสลงในข้อความ — ผู้ดูแลไม่ได้อ่านโค้ด
 *   ทุกข้อความต้องบอก "ต้องทำอะไรต่อ" ไม่ใช่แค่ "อะไรผิด"
 *
 * ★ JOB_NOT_READY / WRONG_SEQUENCE เป็น null โดยตั้งใจ
 *   สองเคสนี้ข้อความจริงมาจากระบบเช็คอินเดิม (เช่น "ยังไม่ได้รับการชำระเงิน")
 *   ซึ่งเจาะจงกว่าข้อความกลาง ๆ ที่เราจะเขียนที่นี่มาก
 */
export const SCAN_RESULT_MESSAGE: Record<ScanResultCode, string | null> = {
  SUCCESS: 'สแกนสำเร็จ',
  TOKEN_NOT_FOUND: 'QR นี้ใช้ไม่ได้ กรุณาให้ผู้รับบริการเปิด QR จากแอปอีกครั้ง',
  NOT_A_CAREGIVER: 'บัญชีนี้ยังไม่มีโปรไฟล์ผู้ดูแล กรุณาติดต่อผู้ดูแลระบบ',
  WRONG_CAREGIVER: 'QR นี้เป็นของงานที่ไม่ใช่ของคุณ',
  BOOKING_INACTIVE: 'งานนี้ถูกยกเลิกแล้ว QR จึงใช้ไม่ได้',
  OUT_OF_WINDOW: 'ยังไม่ถึงเวลาที่สแกนได้ หรือเลยเวลามาแล้ว',
  ALREADY_COMPLETED: 'งานนี้ปิดเรียบร้อยแล้ว ไม่ต้องสแกนอีก',
  TOO_SOON: 'เพิ่งสแกนไปเมื่อครู่ กรุณารอสักครู่แล้วลองใหม่',
  DUPLICATE: 'ระบบบันทึกการสแกนครั้งนี้ไปแล้ว',
  WRONG_SEQUENCE: null,
  JOB_NOT_READY: null,
};
