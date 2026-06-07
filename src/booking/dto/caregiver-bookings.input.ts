import { Field, InputType, Int } from '@nestjs/graphql';
import { IsBoolean, IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import { BookingStatusEnum } from './booking-summary.types';

/**
 * CaregiverBookingsInput — input สำหรับ query `caregiverBookings`
 *
 * ใช้กับ 3 tab ที่ filter ตามสถานะ:
 * - status=pending   → "คำขอใหม่" (ticket #1)
 * - status=accepted  → "รอผู้ป่วยยืนยัน" (ticket #2)
 * - status=confirmed + upcoming=true → "งานในกำหนดเวลา / active jobs" (ticket #5)
 *
 * เทียบ REST เดิม: GET /api/v1/caregiver/bookings?status=...&upcoming=...
 */
@InputType()
export class CaregiverBookingsInput {
  // status เป็น field บังคับ (ไม่ nullable) — ทุก tab ต้องระบุสถานะที่ต้องการ
  @Field(() => BookingStatusEnum)
  @IsEnum(BookingStatusEnum)
  status: BookingStatusEnum;

  // upcoming=true → เอาเฉพาะงานที่ booking_date ตั้งแต่วันนี้เป็นต้นไป (ใช้กับ active jobs)
  @Field({ nullable: true })
  @IsOptional()
  @IsBoolean()
  upcoming?: boolean;

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
