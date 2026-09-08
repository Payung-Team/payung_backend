/**
 * ScanResult / ScanAction — enum ที่ GraphQL schema รู้จัก (PYG-435)
 *
 * ทำไมต้องมีไฟล์นี้ ทั้งที่ qr.constants.ts มีค่าเดียวกันอยู่แล้ว:
 *   constants เป็น object ธรรมดาของ TypeScript — GraphQL มองไม่เห็น
 *   ถ้าประกาศฟิลด์เป็น String เฉย ๆ FE จะไม่มีทางรู้ว่ามีรหัสอะไรบ้าง
 *   ต้องมานั่งไล่ถามหรือเดาเอง แล้วเคสที่ลืมจัดการจะโผล่ตอนขึ้น production
 *
 *   ประกาศเป็น enum แทน → รหัสทั้งหมดโผล่ใน schema.gql → codegen ฝั่ง FE
 *   จะบังคับให้ switch ครบทุกเคสตั้งแต่ตอน compile (PYG-438 ได้ประโยชน์ตรงนี้เต็ม ๆ)
 *
 * ⚠ ค่าของ enum ต้องตรงกับ SCAN_RESULT / SCAN_ACTION ใน qr.constants.ts
 *   และตรงกับ CHECK constraint ในดีบีด้วย — สามที่ ต้องแก้พร้อมกันเสมอ
 *   (มีเทสใน job-scan.service.spec.ts คอยจับว่าสองที่แรกตรงกันไหม)
 */
import { registerEnumType } from '@nestjs/graphql';

/** action ที่การสแกนครั้งนั้นพยายามจะทำ — ตัดสินจากสถานะของ session ไม่ใช่จากตัว QR */
export enum ScanAction {
  CHECK_IN = 'CHECK_IN',
  CHECK_OUT = 'CHECK_OUT',
  NONE = 'NONE',
}

registerEnumType(ScanAction, {
  name: 'ScanAction',
  description:
    'สิ่งที่การสแกนครั้งนี้ทำ (หรือพยายามจะทำ). NONE = ยังไม่ทันรู้ว่าจะทำอะไร เช่น หา QR ไม่เจอ',
});

/** ผลลัพธ์ของการสแกน 1 ครั้ง — FE ใช้ค่านี้เลือกหน้าจอที่จะแสดง */
export enum ScanResult {
  SUCCESS = 'SUCCESS',
  TOKEN_NOT_FOUND = 'TOKEN_NOT_FOUND',
  NOT_A_CAREGIVER = 'NOT_A_CAREGIVER',
  WRONG_CAREGIVER = 'WRONG_CAREGIVER',
  BOOKING_INACTIVE = 'BOOKING_INACTIVE',
  OUT_OF_WINDOW = 'OUT_OF_WINDOW',
  ALREADY_COMPLETED = 'ALREADY_COMPLETED',
  TOO_SOON = 'TOO_SOON',
  DUPLICATE = 'DUPLICATE',
  WRONG_SEQUENCE = 'WRONG_SEQUENCE',
  JOB_NOT_READY = 'JOB_NOT_READY',
}

registerEnumType(ScanResult, {
  name: 'ScanResult',
  description:
    'ผลของการสแกน. SUCCESS เท่านั้นที่แปลว่างานขยับจริง ค่าอื่นทั้งหมดคือถูกปฏิเสธ (แต่ถูกบันทึกไว้ทุกครั้ง)',
});
