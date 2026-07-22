/**
 * NotificationType Enum — ประเภทของ in-app notification (PYG-95)
 *
 * ทำไมต้อง registerEnumType?
 * - GraphQL ไม่รู้จัก TypeScript enum โดยตรง ต้อง register ให้ schema รู้จัก
 * - ชื่อที่ register จะปรากฏใน GraphQL schema (ใช้ใน query/mutation ฝั่ง client)
 *
 * ค่าของ enum ต้อง "ตรง" กับ Prisma NotificationType enum ในไฟล์ schema.prisma
 * ถ้าเพิ่ม type ใหม่ต้องแก้ทั้ง 2 ที่ + rerun migration
 */
import { registerEnumType } from '@nestjs/graphql';

export enum NotificationType {
  // ─── KYC lifecycle (PYG-95) ──────────────────────────────────────────────
  kyc_submitted = 'kyc_submitted',        // caregiver ส่ง KYC เข้ามา
  kyc_verified = 'kyc_verified',          // KYC ผ่าน
  kyc_rejected = 'kyc_rejected',          // KYC ไม่ผ่าน
  kyc_resubmitted = 'kyc_resubmitted',    // caregiver ส่ง KYC ใหม่หลังถูก reject

  // ─── Booking lifecycle (PYG-292) ─────────────────────────────────────────
  // ⚠️ ค่าทั้งหมดต้อง "ตรง" กับ Prisma enum NotificationType ใน schema.prisma เป๊ะ
  // เดิม entity นี้มีแค่ 4 KYC types ทั้งที่ DB/Prisma มี booking_* อยู่แล้ว —
  // ยังไม่พังเพราะ "ยังไม่เคยมีใครสร้าง" booking notification (PYG-292 คือตัวเริ่มสร้าง)
  // ถ้าไม่ sync ที่นี่ GraphQL จะ serialize ค่า booking_* ไม่ได้ → query notifications พัง
  booking_new = 'booking_new',                  // มีคำขอจองใหม่ (→ caregiver)
  booking_accepted = 'booking_accepted',        // ผู้ดูแลรับคำขอแล้ว (→ patient)
  booking_declined = 'booking_declined',        // ผู้ดูแลปฏิเสธคำขอ (→ patient)
  booking_confirmed = 'booking_confirmed',      // การจองยืนยันแล้ว (→ caregiver)
  booking_completed = 'booking_completed',      // บริการเสร็จสิ้น (→ patient)
  booking_cancelled = 'booking_cancelled',      // การจองถูกยกเลิก (→ caregiver)
  payment_held = 'payment_held',                // ชำระเงินเรียบร้อย/กันวงเงิน (→ patient)
  payment_captured = 'payment_captured',        // เรียกเก็บเงินแล้ว (→ caregiver)
  payment_voided = 'payment_voided',            // PYG-286: ยกเลิกการกันวงเงิน (→ patient)
  refund_issued = 'refund_issued',              // คืนเงินเรียบร้อย (→ patient)
  dispute_created = 'dispute_created',           // แจ้งปัญหาใหม่ (→ admin)
  dispute_resolved = 'dispute_resolved',        // ผลตรวจสอบปัญหา (→ patient + caregiver)
  payment_transferred = 'payment_transferred',  // PYG-266: admin โอนเงินให้ caregiver แล้ว (→ caregiver)
}

// register ให้ GraphQL schema รู้จัก — ต้องเรียกครั้งเดียวตอน app bootstrap
registerEnumType(NotificationType, {
  name: 'NotificationType',
  description: 'Type of in-app notification',
});
