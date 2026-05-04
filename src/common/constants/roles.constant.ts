/**
 * Role ID constants
 * ค่าคงที่สำหรับ role IDs ในระบบ
 */

export const ROLE_ID = {
  PATIENT: 1,
  CAREGIVER: 2,
  ADMIN: 3,
} as const;

export const VALID_ROLE_IDS = Object.values(ROLE_ID) as number[];
