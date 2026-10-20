/**
 * Error ของกิจกรรมการดูแล (PYG-634 · S15 · contract PYG-632)
 *
 * GraphQLError + extensions แบบเดียวกับ CareLevelError / ProfessionError — code ไม่หายระหว่างทาง
 * (Nest HttpException 422 ถูก @nestjs/apollo แปลงเป็น BAD_USER_INPUT)
 * `statusCode: 422` = business rule ไม่ผ่าน ไม่ใช่ 400
 *
 * Contract กับ FE (ห้ามเปลี่ยนสตริงของ code โดยไม่บอกทีม FE):
 *   { code: 'CARE_ACTIVITY_NOT_FOUND', activityIds: [...] }
 *   { code: 'CARE_ACTIVITY_INACTIVE', activityIds: [...] }       — จองด้วยกิจกรรมที่ปิดใช้งาน (E2)
 *   { code: 'CARE_ACTIVITY_DUPLICATE', category, nameTh }        — ชื่อซ้ำในหมวดเดียวกัน (E3)
 *   { code: 'CARE_ACTIVITY_INVALID', field, reason }             — ช่องบังคับว่าง / ระดับนอก 3 ค่า / ยาวเกิน
 *
 * การจอง (REST + GraphQL ใช้ createBookingRecord ร่วมกัน) โยน CareActivityError ตัวเดียวกัน
 * แล้ว BookingService แปลงเป็น 422 JSON ที่ทาง REST (ดู toRestError)
 */
import { GraphQLError } from 'graphql';
import { UnprocessableEntityException } from '@nestjs/common';

export const CARE_ACTIVITY_ERROR = {
  NOT_FOUND: 'CARE_ACTIVITY_NOT_FOUND',
  INACTIVE: 'CARE_ACTIVITY_INACTIVE',
  DUPLICATE: 'CARE_ACTIVITY_DUPLICATE',
  INVALID: 'CARE_ACTIVITY_INVALID',
} as const;

export type CareActivityErrorCode =
  (typeof CARE_ACTIVITY_ERROR)[keyof typeof CARE_ACTIVITY_ERROR];

export class CareActivityError extends GraphQLError {
  constructor(
    message: string,
    public readonly code: CareActivityErrorCode,
    public readonly extra: Record<string, unknown> = {},
  ) {
    super(message, {
      extensions: { code, statusCode: 422, http: { status: 422 }, ...extra },
    });
  }

  /** ทาง REST (POST /bookings) — GraphQLError ใน controller จะกลายเป็น 500 จึงแปลงเป็น 422 ที่มี code */
  toRestError(): UnprocessableEntityException {
    return new UnprocessableEntityException({
      statusCode: 422,
      code: this.code,
      message: this.message,
      ...this.extra,
    });
  }
}
