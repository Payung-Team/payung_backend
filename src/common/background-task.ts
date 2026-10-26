/**
 * runInBackground — งาน fire-and-forget ที่ต้องรันจนจบแม้ response ถูกส่งกลับไปแล้ว
 *
 * ทำไมไม่ใช้ `void promise` ตรง ๆ:
 *   บน Node (local) process รันต่อหลังส่ง response → promise ทำงานจนจบ
 *   บน Cloudflare Workers request จบ = งานที่ไม่ได้ผูกกับ waitUntil ถูกตัดทิ้งเงียบ ๆ
 *   (เช่น createRecipientForCaregiver หลัง approveKyc ไม่เคยยิงถึง Omise บน cloud)
 *
 * worker.ts ลงทะเบียน waitUntil ของ `cloudflare:workers` ตอนโหลดโมดูล
 * ฝั่ง Node ไม่มีใครลงทะเบียน → ทำงานแบบ `void` เหมือนเดิม
 *
 * caller ยังต้อง catch error เอง — helper นี้ไม่กลืน error ให้
 */
import { Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

type WaitUntil = (promise: Promise<unknown>) => void;

let registeredWaitUntil: WaitUntil | undefined;

const logger = new Logger('BackgroundTask');

/** worker.ts เรียกตอนโหลดโมดูล · test ส่ง undefined เพื่อล้างกลับเป็นแบบ Node */
export function registerBackgroundWaitUntil(
  waitUntil: WaitUntil | undefined,
): void {
  registeredWaitUntil = waitUntil;
}

export function runInBackground(task: Promise<unknown>): void {
  if (registeredWaitUntil) {
    registeredWaitUntil(task);
    return;
  }
  void task;
}

/**
 * keepEventListenersAlive — ผูกทุก event ของ EventEmitter2 กับ waitUntil (PYG-727 / PYG-726)
 *
 * ปัญหา: service ยิง event ด้วย `eventEmitter.emit(...)` แล้วตอบ mutation กลับทันที
 *   emit ไม่รอ listener ที่เป็น async (BookingNotificationListener, PayoutCreationListener)
 *   บน Workers พอส่ง response แล้วงานที่ยังค้างถูกตัดทิ้ง → ไม่มี notification / อีเมล / ใบ payout
 *   listener ทั้งสองเป็น request-scoped (พึ่ง PrismaService) ต้องสร้าง instance + เปิด DB connection
 *   ใหม่ก่อนทุกครั้ง จึงแทบไม่เคยทำเสร็จทันก่อน response
 *
 * วิธีแก้: แทน `emit` ของ emitter ตัวนี้ด้วย `emitAsync`
 *   · emitAsync เรียก listener ทันทีเหมือน emit (ลำดับเดิม ข้อมูลเดิม) แต่คืน promise ที่รอ
 *     listener async ทำงานจนจบ → ส่ง promise นั้นให้ waitUntil
 *   · caller ไม่ได้ await อยู่แล้ว response จึงไม่ช้าลง
 *   ★ แก้ที่เดียว ครอบทุกจุดที่ยิง event รวมถึงจุดที่จะเพิ่มในอนาคต — ไม่ต้องจำไปใช้ emitAsync เอง
 *   ★ บน Node ไม่มีใครลงทะเบียน waitUntil → ไม่แตะ emitter เลย พฤติกรรมเหมือนเดิมทุกอย่าง
 *
 * worker.ts เรียกครั้งเดียวหลัง app.init()
 */
export function keepEventListenersAlive(emitter: EventEmitter2): void {
  if (!registeredWaitUntil) return;

  // ★ แทนแค่ emit — emitAsync ยังเป็นของเดิมจาก prototype จึงเรียกผ่าน emitter ได้ตรง ๆ
  emitter.emit = (event, ...values: unknown[]) => {
    runInBackground(
      emitter.emitAsync(event, ...values).catch((err: unknown) => {
        // listener ของเรา catch เองอยู่แล้ว ตรงนี้กันไว้ไม่ให้ promise ที่ส่งให้ waitUntil reject
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`Event listener failed for "${String(event)}": ${msg}`);
      }),
    );
    // คืนค่าเหมือน emit เดิม: มี listener ของ event นี้หรือไม่
    return emitter.listenerCount(event) > 0;
  };
}
