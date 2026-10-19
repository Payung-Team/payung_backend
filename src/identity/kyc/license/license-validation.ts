/**
 * กฎความครบ/ถูกต้องของใบประกอบฯ — อยู่ชั้น service ไม่พึ่ง DTO (PYG-415: decorator ใน DTO ตอบ 400 ก่อนถึงตรงนี้)
 */
import { LICENSE_NUMBER_MAX_LENGTH, LICENSE_STATUS } from './license.constants';
import { LICENSE_ERROR, LicenseError, LicenseErrorCode } from './license.errors';
import { isBangkokDateInFuture, toBangkokEndOfDay } from './license-date';

/** E5: ตัดช่องว่างหัวท้าย — ว่าง/ไม่มี → null */
export function normalizeLicenseNumber(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

/** ข้อมูลใบประกอบฯ ที่ตรวจแล้ว พร้อมบันทึก */
export interface ValidLicenseFields {
  licenseNumber: string;
  /** สิ้นวันหมดอายุตามเวลาไทย */
  expiresAt: Date;
}

/**
 * ตรวจเลข + วันหมดอายุ — ขาด/ผิดหลายช่องตอบครบในครั้งเดียว (`codes`)
 * @throws LicenseError (422)
 */
export function validateLicenseFields(
  rawNumber: string | null | undefined,
  rawExpiry: Date | null | undefined,
  now: Date,
): ValidLicenseFields {
  const errors: LicenseErrorCode[] = [];
  const licenseNumber = normalizeLicenseNumber(rawNumber);

  if (!licenseNumber) errors.push(LICENSE_ERROR.NUMBER_REQUIRED);
  else if (licenseNumber.length > LICENSE_NUMBER_MAX_LENGTH) {
    errors.push(LICENSE_ERROR.NUMBER_TOO_LONG);
  }

  const validDate = rawExpiry instanceof Date && !Number.isNaN(rawExpiry.getTime());
  if (!validDate) errors.push(LICENSE_ERROR.EXPIRY_REQUIRED);
  else if (!isBangkokDateInFuture(rawExpiry, now)) errors.push(LICENSE_ERROR.EXPIRY_NOT_FUTURE);

  if (errors.length > 0) throw new LicenseError(errors[0], errors);

  return { licenseNumber: licenseNumber as string, expiresAt: toBangkokEndOfDay(rawExpiry as Date) };
}

/** ใบที่อ่านจาก kyc_documents เท่าที่ต้องใช้ตัดสิน */
export interface StoredLicenseDoc {
  licenseNumber: string | null;
  expiresAt: Date | null;
  reviewStatus: string | null;
}

/**
 * ใบที่อัปโหลดไว้แล้วใช้ยื่นได้ไหม (PYG-663 · กติกาเดียวกับ KYC ของ S03)
 * - ไม่มี / ถูกปฏิเสธ / หมดอายุแล้ว → LICENSE_FILE_REQUIRED (ต้องอัปโหลดใบใหม่ · E6)
 * - ขาดเลข / วันหมดอายุ / วันหมดอายุไม่ใช่อนาคต (เวลาไทย) → ตอบครบทุกช่องในครั้งเดียว
 * @throws LicenseError (422)
 */
export function assertUsableLicenseDoc(doc: StoredLicenseDoc | null, now: Date): void {
  if (
    !doc ||
    doc.reviewStatus === LICENSE_STATUS.REJECTED ||
    doc.reviewStatus === LICENSE_STATUS.EXPIRED
  ) {
    throw new LicenseError(LICENSE_ERROR.FILE_REQUIRED);
  }

  const errors: LicenseErrorCode[] = [];
  if (!normalizeLicenseNumber(doc.licenseNumber)) errors.push(LICENSE_ERROR.NUMBER_REQUIRED);
  if (!doc.expiresAt) errors.push(LICENSE_ERROR.EXPIRY_REQUIRED);
  else if (!isBangkokDateInFuture(doc.expiresAt, now)) errors.push(LICENSE_ERROR.EXPIRY_NOT_FUTURE);
  if (errors.length > 0) throw new LicenseError(errors[0], errors);
}
