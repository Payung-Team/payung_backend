/**
 * ชื่อ "ตามบัญชี" ของผู้ใช้ — PYG-516 / PYG-517
 *
 * ★ ต้องเป็นฟังก์ชันเดียวที่ทั้งระบบใช้ ไม่ใช่ตรรกะที่ก๊อปไว้สองที่
 *   PYG-517 เอาไปโชว์บนปุ่ม shortcut ตอนเลือกสมาชิก ส่วน PYG-516 เอาไปเขียนลง
 *   `care_recipients.name` และ `bookings.patient_name` — ถ้าสองฝั่งคำนวณคนละแบบ
 *   ผู้ใช้จะกดชื่อหนึ่งแล้วใบจองขึ้นอีกชื่อหนึ่ง โดยไม่มี error ให้เห็น
 *
 * ลำดับ: `first_name last_name` (กรอกตอน Onboarding — PYG-496/497)
 *        → ไม่มีก็ `display_name` (บัญชีเก่าที่สมัครก่อน Onboarding ได้ค่านี้จาก provider)
 */
export interface AccountNameSource {
  firstName?: string | null;
  lastName?: string | null;
  displayName?: string | null;
}

/**
 * คืนชื่อที่ใช้แสดง/บันทึก หรือ `null` เมื่อบัญชีไม่มีชื่อเลย
 *
 * ★ คืน null ไม่ใช่สตริงอย่าง "ผู้ใช้ #xxxx" — ผู้เรียกต้องตัดสินเองว่าจะปฏิเสธ
 *   หรือจะปล่อยว่าง การเดาชื่อให้ทำให้ใบงานที่ผู้ดูแลถือไประบุตัวคนไม่ได้
 */
export function accountDisplayName(
  account: AccountNameSource | null | undefined,
): string | null {
  const full = [account?.firstName, account?.lastName]
    .map((part) => part?.trim())
    .filter((part): part is string => !!part)
    .join(' ');

  return full || account?.displayName?.trim() || null;
}

/** คอลัมน์ที่ `accountDisplayName` ต้องใช้ — ใส่ใน select ของ Prisma ให้ครบ */
export const ACCOUNT_NAME_SELECT = {
  firstName: true,
  lastName: true,
  displayName: true,
} as const;
