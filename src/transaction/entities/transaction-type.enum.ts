import { registerEnumType } from '@nestjs/graphql';

/**
 * PYG-333 — ประเภทของ "transaction" ในหน้า admin (มุมมองรวม)
 *
 * ระบบเราไม่มีตาราง refunds แยกต่างหาก → เรารวมข้อมูลจาก 2 ตารางจริง:
 *   - payments  → เป็น `payment` (เงินเข้าจาก patient)
 *                 ยกเว้นสถานะ refunded / partially_refunded → นับเป็น `refund` (เงินคืน patient)
 *   - payouts   → เป็น `payout` (เงินออกให้ caregiver)
 *
 * ค่าเป็น lowercase ให้เข้ากับ enum อื่นในโปรเจกต์ (PaymentStatus, DisputeFiledBy)
 */
export enum TransactionType {
  payment = 'payment',
  payout = 'payout',
  refund = 'refund',
}

registerEnumType(TransactionType, {
  name: 'TransactionType',
  description:
    'ประเภท transaction: payment (เงินเข้า) | payout (เงินออกให้ caregiver) | refund (เงินคืน patient) (PYG-333)',
});
