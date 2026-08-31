import {
  IsArray,
  IsDateString,
  IsLatitude,
  IsLongitude,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ArrayMinSize,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreateBookingDto {
  /** ผู้รับบริการ (optional — ถ้าไม่ส่งมา = ผู้ป่วยเอง) */
  @IsOptional()
  @IsUUID()
  careRecipientId?: string;

  /** caregiver ที่ patient เลือก (optional — ถ้าส่งมา status จะเป็น pending ทันที) */
  @IsOptional()
  @IsUUID()
  caregiverId?: string;

  /**
   * รายการงาน (label strings เช่น ["อาบน้ำ", "ป้อนอาหาร"])
   * ต้องมีอย่างน้อย 1 รายการ
   */
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  tasks!: string[];

  /**
   * สถานที่ให้บริการ (ชื่อสถานที่ เช่น ["บ้าน", "โรงพยาบาล"])
   * ต้องมีอย่างน้อย 1 รายการ
   */
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  serviceLocations!: string[];

  /** ประเภทบริการ เช่น "elderly_care" */
  @IsString()
  @IsNotEmpty()
  serviceType!: string;

  /** ช่วงเวลา เช่น "morning" | "afternoon" | "evening" */
  @IsString()
  @IsNotEmpty()
  timeSlot!: string;

  /**
   * เวลาเริ่มต้น เช่น "09:00:00"
   * เก็บเป็น Time ใน PostgreSQL
   */
  @IsString()
  @IsNotEmpty()
  startTime!: string;

  /** จำนวนชั่วโมง (เช่น 4, 8) */
  @IsNumber()
  @Min(0.5)
  @Type(() => Number)
  durationHours!: number;

  /** ที่อยู่บริการ */
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  locationAddress!: string;

  /**
   * PYG-352 — พิกัดจุดงาน (จาก MapPicker ที่ลูกค้าปักหมุดตอนจอง)
   *
   * ทำไมเพิ่งมามีตอนนี้: ฝั่ง FE ประกอบค่า at_home:{address,lat,lng} มานานแล้ว
   * (BookingStep1.tsx) แต่ DTO ฝั่งนี้ไม่เคยมีช่องรับ → พิกัดถูกทิ้งที่ API boundary
   * ทุกครั้ง ทำให้ bookings.location_lat/lng เป็น NULL ทั้งตาราง
   *
   * optional เพราะ: booking แบบพาไปข้างนอกหรือเคสที่ลูกค้าไม่ปักหมุดยังต้องจองได้
   * ถ้าเป็น NULL ระบบเช็คอินจะ "ไม่คำนวณระยะ และไม่ติดธง" — ไม่ลงโทษผู้ดูแล
   * เพราะข้อมูลที่ขาดเป็นความผิดของเราเอง
   */
  @IsOptional()
  @IsNumber()
  @IsLatitude()
  @Type(() => Number)
  lat?: number;

  @IsOptional()
  @IsNumber()
  @IsLongitude()
  @Type(() => Number)
  lng?: number;

  /** วันที่ให้บริการ รูปแบบ ISO: "2026-07-15" */
  @IsDateString()
  bookingDate!: string;

  /** ชื่อผู้ป่วย (กรณีไม่ได้เลือก careRecipientId) */
  @IsOptional()
  @IsString()
  @MaxLength(255)
  patientName?: string;

  // ── วันที่ให้บริการ — ผู้ติดต่อ ──────────────────────────────────────────
  @IsOptional()
  @IsString()
  @MaxLength(255)
  dayOfContactName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  dayOfContactPhone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  dayOfContactRelationship?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}
