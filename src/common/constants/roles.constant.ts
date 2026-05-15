/**
 * Role ID constants
 * ค่าคงที่สำหรับ role IDs ในระบบ
 */

export const ROLE_ID = {
  PATIENT: 1,
  CAREGIVER: 2,
  ADMIN: 3,
  SUPER_ADMIN: 4, // PYG-152: ผู้ดูแลระบบระดับสูง — เหนือกว่า admin (ใช้กับ mutation ที่ sensitive มาก)
} as const;

// VALID_ROLE_IDS อัปเดตอัตโนมัติจาก Object.values(ROLE_ID)
// ดังนั้นพอเพิ่ม SUPER_ADMIN ด้านบน → [1, 2, 3, 4] โดยไม่ต้องแก้บรรทัดนี้
export const VALID_ROLE_IDS = Object.values(ROLE_ID) as number[];
