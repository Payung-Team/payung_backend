/**
 * Error ของใบขับขี่ — contract PYG-596
 *
 * GraphQLError + extensions.code (แพตเทิร์นเดียวกับ LicenseError) · business rule = 422 ไม่ใช่ 400
 */
import { GraphQLError } from 'graphql';

export const DRIVING_LICENSE_ERROR = {
  /** ระบุว่าขับรถรับส่งเองแต่ไม่มีใบขับขี่ */
  REQUIRED: 'DRIVING_LICENSE_REQUIRED',
  /** ไม่ส่งวันหมดอายุ */
  EXPIRY_REQUIRED: 'DRIVING_LICENSE_EXPIRY_REQUIRED',
  /** วันหมดอายุผ่านมาแล้ว (ตอนอัปโหลด/ส่ง KYC/อนุมัติ) */
  EXPIRED: 'DRIVING_LICENSE_EXPIRED',
  /** รับงานรับส่งโดยใบขับขี่ไม่ผ่านหรือหมดอายุ */
  NOT_VERIFIED: 'DRIVING_LICENSE_NOT_VERIFIED',
  /** ปฏิเสธโดยไม่มีเหตุผล */
  REJECT_REASON_REQUIRED: 'REJECT_REASON_REQUIRED',
  /** ส่ง transportMode และ selfDriveTransport มาพร้อมกันแต่ขัดกัน */
  TRANSPORT_MODE_CONFLICT: 'TRANSPORT_MODE_CONFLICT',
} as const;

export type DrivingLicenseErrorCode =
  (typeof DRIVING_LICENSE_ERROR)[keyof typeof DRIVING_LICENSE_ERROR];

const MESSAGE: Record<DrivingLicenseErrorCode, string> = {
  DRIVING_LICENSE_REQUIRED: 'กรุณาอัปโหลดใบขับขี่ เนื่องจากคุณระบุว่าขับรถรับส่งเอง',
  DRIVING_LICENSE_EXPIRY_REQUIRED: 'กรุณาระบุวันหมดอายุของใบขับขี่',
  DRIVING_LICENSE_EXPIRED: 'ใบขับขี่หมดอายุแล้ว',
  DRIVING_LICENSE_NOT_VERIFIED: 'ใบขับขี่ยังไม่ผ่านการตรวจสอบหรือหมดอายุ จึงรับงานที่ต้องขับรถรับส่งไม่ได้',
  REJECT_REASON_REQUIRED: 'ต้องระบุเหตุผลที่ปฏิเสธ',
  TRANSPORT_MODE_CONFLICT: 'transportMode กับ selfDriveTransport ขัดกัน — ส่งอย่างใดอย่างหนึ่ง หรือส่งให้ตรงกัน',
};

export class DrivingLicenseError extends GraphQLError {
  constructor(public readonly drivingLicenseCode: DrivingLicenseErrorCode) {
    super(MESSAGE[drivingLicenseCode], {
      extensions: { code: drivingLicenseCode, statusCode: 422, http: { status: 422 } },
    });
  }
}
