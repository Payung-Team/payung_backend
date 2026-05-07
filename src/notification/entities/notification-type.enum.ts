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
  kyc_submitted = 'kyc_submitted',        // caregiver ส่ง KYC เข้ามา
  kyc_verified = 'kyc_verified',          // KYC ผ่าน
  kyc_rejected = 'kyc_rejected',          // KYC ไม่ผ่าน
  kyc_resubmitted = 'kyc_resubmitted',    // caregiver ส่ง KYC ใหม่หลังถูก reject
}

// register ให้ GraphQL schema รู้จัก — ต้องเรียกครั้งเดียวตอน app bootstrap
registerEnumType(NotificationType, {
  name: 'NotificationType',
  description: 'Type of in-app notification',
});
