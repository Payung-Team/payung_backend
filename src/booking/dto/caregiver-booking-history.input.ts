import { Field, InputType, Int } from '@nestjs/graphql';
import {
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  Max,
  Min,
} from 'class-validator';
import { BookingStatusEnum } from './booking-summary.types';

/**
 * CaregiverBookingHistoryInput — input สำหรับ query `caregiverBookingHistory` (ticket #7)
 *
 * หน้า "ประวัติงาน" มี filter ได้:
 * - สถานะ (เสร็จสิ้น / ยกเลิก / ปฏิเสธ) — ถ้าไม่ส่ง = ทุกสถานะ
 * - ช่วงวันที่ (เริ่มต้นวันที่ / ถึงวันที่) ตาม design
 *
 * เทียบ REST เดิม: GET /api/v1/caregiver/bookings/history
 */
@InputType()
export class CaregiverBookingHistoryInput {
  @Field(() => BookingStatusEnum, { nullable: true })
  @IsOptional()
  @IsEnum(BookingStatusEnum)
  status?: BookingStatusEnum;

  // กรองตามช่วง booking_date — รับเป็น string รูปแบบ ISO date (เช่น "2026-06-01")
  @Field({ nullable: true })
  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsDateString()
  dateTo?: string;

  @Field(() => Int, { nullable: true, defaultValue: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  page?: number;

  @Field(() => Int, { nullable: true, defaultValue: 10 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}
