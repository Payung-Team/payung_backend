import {
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  IsNotEmpty,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { PatientProfileDto } from './patient-profile.dto';

export class CreateCareRecipientDto {
  /** ชื่อเต็มของผู้รับบริการ */
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  @MaxLength(255)
  name!: string;

  /** ชื่อเล่น (optional) */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  nickname?: string;

  /**
   * PYG-460 — ข้อมูลสุขภาพ
   *
   * ชื่อคีย์ "details" ตรงกับที่ FE ประกาศไว้แล้วใน SavedRecipient.details
   * (BookingStepPatient.tsx) จงใจให้ request กับ response ใช้รูปทรงเดียวกัน
   * เพื่อให้ค่าที่เพิ่งบันทึกเอามาเติมฟอร์มรอบหน้าได้โดยไม่ต้องแปลงอีกชั้น
   */
  @IsOptional()
  @ValidateNested()
  @Type(() => PatientProfileDto)
  details?: PatientProfileDto;
}

export class UpdateCareRecipientDto {
  /** ชื่อเต็มของผู้รับบริการ */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name?: string;

  /** ชื่อเล่น */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  nickname?: string;

  /**
   * PYG-460 — ข้อมูลสุขภาพ (merge ทีละช่อง ไม่ใช่แทนที่ทั้งก้อน)
   * ส่ง { age: 73 } มาอย่างเดียวจะแก้แค่อายุ ช่องอื่นที่เคยกรอกไว้ยังอยู่ครบ
   * ดู toCareRecipientColumns ใน patient-profile.mapper.ts
   */
  @IsOptional()
  @ValidateNested()
  @Type(() => PatientProfileDto)
  details?: PatientProfileDto;
}
