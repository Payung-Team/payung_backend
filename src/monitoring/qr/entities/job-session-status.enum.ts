/**
 * JobSessionStatus — สถานะของใบ QR ที่ GraphQL schema รู้จัก (PYG-436)
 *
 * ทำไมมาทีหลัง 434/435: สองการ์ดนั้นส่ง status ออกไปเป็น String เฉย ๆ
 * การ์ด PYG-436 ระบุ "+enum JobSessionStatus" ไว้ตรง ๆ และตอนนี้เป็นจังหวะ
 * ที่แก้ได้ถูกที่สุด — FE (PYG-437/438) ยังไม่เริ่มเขียน ยังไม่มีใครพัง
 *
 * ประโยชน์จริงกับ FE: ดีไซน์ PYG-439 ระบุ status chip ไว้ 3 แบบพอดี
 * (PENDING / CHECKED_IN / CHECKED_OUT) พอเป็น enum แล้ว codegen จะบังคับให้
 * เขียน chip ครบทั้งสามตั้งแต่ตอน compile แทนที่จะไปเจอ chip หายตอนทดสอบ
 *
 * ★ เดินหน้าทางเดียวเสมอ: PENDING → CHECKED_IN → CHECKED_OUT
 *   ถอยหลังไม่ได้ (บังคับด้วย compare-and-swap ใน JobScanService)
 *
 * ★ ไม่มี CANCELLED โดยตั้งใจ — "งานถูกยกเลิกไหม" อ่านจาก bookings.status ที่เดียว
 *
 * ⚠ ค่าต้องตรงกับ 2 ที่: JOB_SESSION_STATUS ใน qr.constants.ts
 *   และ CHECK "job_sessions_status_check" ในดีบี
 *   (มีเทสใน job-scan.service.spec.ts จับสองที่แรกให้)
 */
import { registerEnumType } from '@nestjs/graphql';

export enum JobSessionStatus {
  /** เพิ่งสร้าง ยังไม่มีใครสแกน → สแกนครั้งต่อไปคือ "เช็คอิน" */
  PENDING = 'PENDING',
  /** เช็คอินแล้ว กำลังทำงาน → สแกนครั้งต่อไปคือ "เช็คเอาท์" */
  CHECKED_IN = 'CHECKED_IN',
  /** ปิดงานแล้ว → สแกนอีกไม่ได้ */
  CHECKED_OUT = 'CHECKED_OUT',
}

registerEnumType(JobSessionStatus, {
  name: 'JobSessionStatus',
  description:
    'สถานะของใบ QR — เดินหน้าทางเดียว PENDING → CHECKED_IN → CHECKED_OUT. ไม่มีสถานะ "ยกเลิก" เพราะเรื่องนั้นอ่านจากสถานะของ booking',
});

/**
 * แปลงค่า status ที่อ่านมาจากดีบี (Prisma ให้มาเป็น string) ให้เป็น enum
 *
 * ★ ไม่ได้ throw เวลาเจอค่าแปลก โดยตั้งใจ — ดีบีมี CHECK constraint กันไว้แล้ว
 *   ว่าเป็นได้แค่ 3 ค่านี้ ถ้าหลุดมาได้จริงแปลว่าดีบีถูกแก้มือ ซึ่งการทำให้
 *   หน้าจอผู้ดูแลพังทั้งหน้าไม่ได้ช่วยอะไร → ตอบ PENDING ซึ่งเป็นค่าที่ปลอดภัยที่สุด
 *   (แปลว่า "ยังไม่เริ่ม" → อย่างมากก็แค่ให้สแกนเช็คอินใหม่ ไม่ได้ปิดงานให้ใครฟรี ๆ)
 */
export function toJobSessionStatus(value: string): JobSessionStatus {
  return Object.values(JobSessionStatus).includes(value as JobSessionStatus)
    ? (value as JobSessionStatus)
    : JobSessionStatus.PENDING;
}
