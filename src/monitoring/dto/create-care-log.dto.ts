import { Transform } from 'class-transformer';
import { IsIn, IsISO8601, IsString, ValidateBy } from 'class-validator';
import {
  CARE_LOG_BODY_MAX_CHARS,
  CARE_LOG_BODY_MIN_CHARS,
  CARE_LOG_CATEGORY_VALUES,
} from '../monitoring.constants';

/**
 * นับความยาวเป็น code point ให้ตรงกับ char_length() ของ Postgres
 * (@MaxLength ของ class-validator นับ UTF-16 — emoji 1 ตัวนับเป็น 2 ทำให้เพี้ยนจาก CHECK ฝั่ง DB)
 */
function CodePointLength(min: number, max: number) {
  return ValidateBy({
    name: 'codePointLength',
    validator: {
      validate: (value: unknown) =>
        typeof value === 'string' &&
        [...value].length >= min &&
        [...value].length <= max,
      defaultMessage: (args) =>
        typeof args?.value === 'string' && [...args.value].length > max
          ? `ข้อความยาวเกินกำหนด (สูงสุด ${max} ตัวอักษร)`
          : 'กรุณากรอกข้อความบันทึก',
    },
  });
}

/**
 * CreateCareLogDto — field ข้อความของ multipart/form-data (PYG-466)
 * POST /api/v1/monitoring/bookings/:bookingId/care-logs
 *
 * ไฟล์รูป (field `photo`) ไม่อยู่ใน DTO — FileInterceptor แยกออกไปให้ก่อนถึง ValidationPipe
 * ★ display-only: ไม่มีผลต่อ proofOfWork.verdict หรือการปล่อยเงินใด ๆ ทั้งสิ้น
 */
export class CreateCareLogDto {
  @IsIn(CARE_LOG_CATEGORY_VALUES, { message: 'หมวดหมู่ไม่ถูกต้อง' })
  category: string;

  // trim ที่นี่ → ค่าที่ validate = ค่าที่ insert (ข้อความที่มีแต่ช่องว่างจึงไม่ผ่าน)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @CodePointLength(CARE_LOG_BODY_MIN_CHARS, CARE_LOG_BODY_MAX_CHARS)
  body: string;

  /** บังคับบน endpoint นี้ — ช่วงที่ยอมรับตรวจใน service (ต้องรู้เวลาเช็คอินจริง) */
  @IsString({ message: 'กรุณาส่ง deviceTs' })
  @IsISO8601({ strict: true }, { message: 'deviceTs ต้องเป็นเวลา ISO 8601' })
  deviceTs: string;
}
