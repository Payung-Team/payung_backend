/**
 * File Validation Constants — กฎสำหรับตรวจสอบไฟล์ที่อัปโหลด
 *
 * ใช้ใน upload endpoint (เช่น uploadKycDocument) เพื่อตรวจสอบว่า
 * ไฟล์ที่ user อัปโหลดมีขนาดและประเภทที่อนุญาต
 *
 * ตาม AC ของ PYG-63:
 * - ไฟล์ต้องไม่เกิน 10MB
 * - รองรับเฉพาะ jpg, png, pdf
 */

/** ขนาดไฟล์สูงสุด: 10MB (หน่วย bytes) */
export const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10,485,760 bytes

/**
 * MIME types ที่อนุญาต
 * - image/jpeg = ไฟล์ .jpg, .jpeg
 * - image/png  = ไฟล์ .png
 * - application/pdf = ไฟล์ .pdf
 */
export const ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'application/pdf',
] as const;

/** นามสกุลไฟล์ที่อนุญาต (สำหรับแสดง error message) */
export const ALLOWED_EXTENSIONS = ['jpg', 'jpeg', 'png', 'pdf'] as const;

/**
 * validateFile — ตรวจสอบไฟล์ที่อัปโหลด
 *
 * ใช้ใน service/resolver ก่อนบันทึกไฟล์ลง storage
 *
 * @param fileSize - ขนาดไฟล์ (bytes)
 * @param mimeType - MIME type ของไฟล์
 * @returns { valid: true } หรือ { valid: false, error: "..." }
 *
 * ตัวอย่าง:
 * const result = validateFile(file.size, file.mimetype);
 * if (!result.valid) throw new BadRequestException(result.error);
 */
export function validateFile(
  fileSize: number,
  mimeType: string,
): { valid: true } | { valid: false; error: string } {
  // ตรวจขนาดไฟล์
  if (fileSize > MAX_FILE_SIZE) {
    const maxMB = MAX_FILE_SIZE / (1024 * 1024);
    return {
      valid: false,
      error: `ไฟล์มีขนาดใหญ่เกินไป (สูงสุด ${maxMB}MB)`,
    };
  }

  // ตรวจประเภทไฟล์
  if (!ALLOWED_MIME_TYPES.includes(mimeType as (typeof ALLOWED_MIME_TYPES)[number])) {
    return {
      valid: false,
      error: `ประเภทไฟล์ไม่รองรับ (รองรับเฉพาะ ${ALLOWED_EXTENSIONS.join(', ')})`,
    };
  }

  return { valid: true };
}
