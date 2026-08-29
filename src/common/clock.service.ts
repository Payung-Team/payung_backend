/**
 * ClockService — ตัวจ่ายเวลาแบบ inject ได้ (PYG-369)
 *
 * ทำไมต้องมี?
 * - ถ้าโค้ดเรียก `new Date()` ตรง ๆ เราจะเขียน test ที่ควบคุมเวลาไม่ได้เลย
 *   เช่น cron ของ PYG-367 ที่ต้องเช็ค "ผ่านไป 24 ชม. หรือยัง" — ถ้าเวลาคุมไม่ได้
 *   ก็ต้องนั่งรอ 24 ชม. จริง ๆ ซึ่งเป็นไปไม่ได้
 * - พอทุกที่เรียก clock.now() แทน test แค่ mock service ตัวนี้ตัวเดียวก็คุมเวลาได้ทั้งระบบ
 *
 * ⚠ หมายเหตุสำหรับคนทำ PYG-369:
 *   ไฟล์นี้เป็นเวอร์ชันขั้นต่ำที่ PYG-352 จำเป็นต้องใช้ (การ์ด PYG-352 ห้ามใช้ new Date())
 *   PYG-369 ขยายต่อได้เลย เช่น เพิ่ม setFixedTime() / advanceBy() สำหรับเทส cron
 *   — ไม่ต้องสร้างไฟล์ใหม่ ใช้ไฟล์นี้ต่อได้
 *
 * วิธีใช้:
 *   constructor(private readonly clock: ClockService) {}
 *   const now = this.clock.now();
 */
import { Injectable } from '@nestjs/common';

@Injectable()
export class ClockService {
  /**
   * เวลาปัจจุบันของ "เซิร์ฟเวอร์" — ถือเป็นเวลาจริงเพียงแหล่งเดียวของระบบ
   *
   * PYG-351 AC ข้อ 3: ห้ามเชื่อนาฬิกาของเครื่อง client เด็ดขาด
   * เพราะผู้ใช้ปรับเวลาในเครื่องตัวเองได้ (เช่น ปรับย้อนหลังให้ดูเหมือนมาตรงเวลา)
   */
  now(): Date {
    return new Date();
  }

  /** เวลาปัจจุบันเป็น epoch milliseconds — สะดวกตอนคำนวณผลต่างเวลา */
  nowMs(): number {
    return this.now().getTime();
  }
}
