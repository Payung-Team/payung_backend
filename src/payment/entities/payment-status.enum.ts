/**
 * PaymentStatus Enum — สถานะของการชำระเงิน (PYG-277)
 *
 * ทำไมต้องมี enum ซ้ำกับ Prisma?
 * - Prisma generate enum เป็น "string literal union" (เช่น 'pending' | 'held' ...)
 *   ซึ่ง GraphQL ไม่รู้จัก → ต้องสร้าง TS enum + registerEnumType ให้ schema รู้จัก
 * - runtime value เป็น string เดียวกันเป๊ะ → cast ไปมาได้ (เหมือน NotificationType)
 *
 * ค่าทุกตัวต้อง "ตรง" กับ enum PaymentStatus (@@map "payment_status_enum") ใน schema.prisma
 * ถ้าเพิ่มสถานะใหม่ต้องแก้ทั้ง 2 ที่ + เพิ่มใน transition map ของ PaymentStateMachine
 *
 * ความหมายแต่ละสถานะ (FSM):
 *   pending             → เพิ่งสร้าง payment record รอ authorize กับ Omise
 *   held                → กันวงเงินไว้แล้ว (authorize สำเร็จ capture=false) รอจบงาน
 *   captured            → ตัดเงินจริงแล้ว (หลังบริการเสร็จ)
 *   transferred         → admin โอนเงินให้ caregiver แล้ว (MVP โอนมือ)
 *   voided              → ยกเลิกการกันวงเงิน (ยกเลิกก่อนวันบริการ)
 *   refunded            → คืนเงินเต็มจำนวน
 *   partially_refunded  → คืนเงินบางส่วน
 *   failed              → authorize ไม่สำเร็จ (บัตรมีปัญหา)
 *   expired             → การกันวงเงินหมดอายุ (เกิน PAYMENT_HOLD_DAYS)
 */
import { registerEnumType } from '@nestjs/graphql';

export enum PaymentStatus {
  pending = 'pending',
  held = 'held',
  captured = 'captured',
  transferred = 'transferred',
  voided = 'voided',
  refunded = 'refunded',
  partially_refunded = 'partially_refunded',
  failed = 'failed',
  expired = 'expired',
}

// register ให้ GraphQL schema รู้จัก — เรียกครั้งเดียวตอน app bootstrap
registerEnumType(PaymentStatus, {
  name: 'PaymentStatus',
  description: 'สถานะการชำระเงินของ booking (FSM)',
});
