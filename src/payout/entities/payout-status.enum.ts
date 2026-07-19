/**
 * PayoutStatus — สถานะของ 1 payout (PYG-331 ก้อน B)
 *
 * mirror pattern ของ PaymentStatus (payment module) — text-based enum,
 * runtime value ตรงกับที่เก็บใน DB column `payouts.status` (TEXT)
 *
 * ทำไม TS enum แยกจาก Prisma?
 * - Prisma column เป็น TEXT อิสระ (ไม่ใช่ enum ระดับ DB) — ทีมเลือกไว้ตั้งแต่ 330
 *   เพราะเพิ่ม state ใหม่ไม่ต้อง ALTER TYPE (PYG-341 ยังไม่แก้)
 * - TS enum ทำให้ state machine + code เรียกด้วยชื่อเดียวกันทุกที่ ไม่พิมพ์ผิด
 *
 * ⚠️ ห้ามเพิ่ม state ใหม่นอก 5 ตัวนี้ (บวก null ตอนสร้าง) โดยไม่ตกลง PYG-336/337 ก่อน
 */
export enum PayoutStatus {
  scheduled = 'scheduled',
  processing = 'processing',
  paid = 'paid',
  failed = 'failed',
  cancelled = 'cancelled',
}
