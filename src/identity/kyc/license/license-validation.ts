/**
 * กฎความครบ/ถูกต้องของใบประกอบฯ — อยู่ชั้น service ไม่พึ่ง DTO (PYG-415: decorator ใน DTO ตอบ 400 ก่อนถึงตรงนี้)
 */
import { LICENSE_NUMBER_MAX_LENGTH } from './license.constants';
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
