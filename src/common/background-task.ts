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
type WaitUntil = (promise: Promise<unknown>) => void;

let registeredWaitUntil: WaitUntil | undefined;

export function registerBackgroundWaitUntil(waitUntil: WaitUntil): void {
  registeredWaitUntil = waitUntil;
}

export function runInBackground(task: Promise<unknown>): void {
  if (registeredWaitUntil) {
    registeredWaitUntil(task);
    return;
  }
  void task;
}
