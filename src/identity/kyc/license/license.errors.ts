/**
 * Error ของใบประกอบวิชาชีพ — contract PYG-585
 *
 * GraphQLError + extensions.code (แพตเทิร์นเดียวกับ consent.errors.ts / FieldLockedError)
 * เพราะ Nest HttpException ที่ไม่มี statusCode จะทำให้ code หายระหว่างทางไป Apollo
 * `statusCode: 422` + `http.status: 422` = business rule ไม่ผ่าน ไม่ใช่ 400 (validation ของ DTO)
 *
 * ขาดหลายช่องพร้อมกัน: ตอบครบทุกช่องในครั้งเดียว — `code` = ช่องแรกตามลำดับ
 * (FILE → NUMBER → EXPIRY) และ `codes` = ทุกช่องที่ขาด
 */
import { GraphQLError } from 'graphql';

export const LICENSE_ERROR = {
  NUMBER_REQUIRED: 'LICENSE_NUMBER_REQUIRED',
  FILE_REQUIRED: 'LICENSE_FILE_REQUIRED',
  EXPIRY_REQUIRED: 'LICENSE_EXPIRY_REQUIRED',
  EXPIRY_NOT_FUTURE: 'LICENSE_EXPIRY_NOT_FUTURE',
  REJECT_REASON_REQUIRED: 'LICENSE_REJECT_REASON_REQUIRED',
  EXPIRED: 'LICENSE_EXPIRED',
  NUMBER_TOO_LONG: 'LICENSE_NUMBER_TOO_LONG',
} as const;

export type LicenseErrorCode = (typeof LICENSE_ERROR)[keyof typeof LICENSE_ERROR];

const MESSAGE: Record<LicenseErrorCode, string> = {
  LICENSE_NUMBER_REQUIRED: 'กรุณากรอกเลขใบประกอบวิชาชีพ',
  LICENSE_FILE_REQUIRED: 'กรุณาแนบไฟล์ใบประกอบวิชาชีพ',
  LICENSE_EXPIRY_REQUIRED: 'กรุณาระบุวันหมดอายุของใบประกอบวิชาชีพ',
  LICENSE_EXPIRY_NOT_FUTURE: 'วันหมดอายุของใบประกอบวิชาชีพต้องเป็นวันในอนาคต',
  LICENSE_REJECT_REASON_REQUIRED: 'ต้องระบุเหตุผลที่ปฏิเสธใบประกอบวิชาชีพ',
  LICENSE_EXPIRED: 'ใบประกอบวิชาชีพหมดอายุแล้ว ไม่สามารถอนุมัติได้',
  LICENSE_NUMBER_TOO_LONG: 'เลขใบประกอบวิชาชีพยาวเกินกำหนด',
};

export class LicenseError extends GraphQLError {
  constructor(
    public readonly licenseCode: LicenseErrorCode,
    codes: LicenseErrorCode[] = [licenseCode],
  ) {
    super(MESSAGE[licenseCode], {
      extensions: {
        code: licenseCode,
        codes,
        statusCode: 422,
        http: { status: 422 },
      },
    });
  }
}
