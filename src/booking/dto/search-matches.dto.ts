import {
  IsArray,
  IsDateString,
  IsNotEmpty,
  IsOptional,
  IsString,
  ArrayMinSize,
} from 'class-validator';

/**
 * SearchMatchesDto — Input สำหรับ POST /api/v1/bookings/search-matches
 *
 * ⚠️ NOTE: endpoint นี้เป็น BASIC PLACEHOLDER สำหรับ Phase 3 matching engine จริง
 * ผลลัพธ์คือ filter พื้นฐาน (verified + searchable + province match) เท่านั้น
 * ยังไม่มี scoring algorithm จริงของ Phase 3
 */
export class SearchMatchesDto {
  /** ประเภทบริการที่ต้องการ เช่น "elderly_care" */
  @IsString()
  @IsNotEmpty()
  serviceType!: string;

  /** จังหวัดที่ต้องการให้บริการ (ใช้ match กับ caregiver.serviceAreaProvince) */
  @IsOptional()
  @IsString()
  province?: string;

  /** สถานที่บริการ */
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  serviceLocations?: string[];

  /** ช่วงเวลา เช่น "morning" */
  @IsOptional()
  @IsString()
  timeSlot?: string;

  /** วันที่ต้องการ (ISO date string "2026-07-15") */
  @IsOptional()
  @IsDateString()
  bookingDate?: string;
}
