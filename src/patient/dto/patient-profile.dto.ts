import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * PYG-460 — ข้อมูลสุขภาพของผู้รับบริการ ตามรูปทรงที่หน้าบ้านใช้อยู่แล้ว
 *
 * ── ทำไมรับเป็นภาษาไทย ไม่ใช่ค่า enum ตรง ๆ ──────────────────────────────────
 *   ค่าพวกนี้มาจากปุ่มในฟอร์ม (BookingStepPatient.tsx: SUPPORT_LEVELS / gender)
 *   ซึ่งเก็บข้อความไทยเป็น id ของตัวเลือกมาตั้งแต่แรก การบังคับให้ FE แปลงเป็น
 *   'assisted' ก่อนส่ง แปลว่าตาราง mapping จะอยู่สองที่ (FE หนึ่ง BE หนึ่ง)
 *   แล้ววันหนึ่งเพิ่มตัวเลือกที่สี่จะแก้ไม่ครบ → รับไทยแล้วแปลงที่เดียวใน mapper
 *
 * ── ทำไมทุกฟิลด์เป็น optional ทั้งที่ฟอร์มบังคับกรอกบางช่อง ────────────────────
 *   FE บังคับ age / gender / supportLevel ที่ฝั่งตัวเองอยู่แล้ว (handleSubmit)
 *   ถ้า BE บังคับซ้ำ เท่ากับเปิดทางใหม่ให้ "จองไม่ผ่าน" ในเคสที่วันนี้จองผ่าน
 *   ซึ่งแย่กว่าบั๊กเดิมที่แค่ข้อมูลไม่ถูกเก็บ — ตรงนี้ validate "ชนิด" อย่างเข้มงวด
 *   แต่ไม่ validate "ความครบ"
 */

/** ค่าที่ปุ่มเพศส่งมา — DB เป็น gender_enum { male, female } */
export const GENDER_LABELS = ['ชาย', 'หญิง'] as const;
export type GenderLabel = (typeof GENDER_LABELS)[number];

/**
 * ค่าที่ปุ่ม "ช่วยเหลือตัวเองได้แค่ไหน" ส่งมา (id ของ SUPPORT_LEVELS ฝั่ง FE)
 *
 * ⚠ FE มี 3 ตัวเลือก แต่ DB enum mobility_level มี 4 ค่า — 'wheelchair' ไม่มีปุ่ม
 *   ให้เลือกในฟอร์มวันนี้ ดู PATIENT_PROFILE_MOBILITY_TO_LABEL ใน mapper
 *   ว่าจัดการขากลับยังไง
 */
export const SUPPORT_LEVEL_LABELS = [
  'ช่วยเหลือตัวเองได้ดี',
  'ช่วยเหลือตัวเองได้เล็กน้อย / ต้องการการช่วยพยุงเดิน',
  'ช่วยเหลือตัวเองไม่ได้ / ติดเตียง',
  // ไม่มีปุ่มใน FE วันนี้ แต่รับไว้เพื่อให้แก้โปรไฟล์ที่มีค่านี้อยู่แล้วแล้วบันทึกกลับได้
  'ใช้รถเข็น',
] as const;
export type SupportLevelLabel = (typeof SUPPORT_LEVEL_LABELS)[number];

export class PatientProfileDto {
  /**
   * อายุเป็นปี — DB เก็บเป็น date_of_birth
   *
   * ⚠ ข้อสมมติที่รอ Siwali ยืนยัน (PYG-460): แปลงเป็นวันที่ 1 ม.ค. ของปีเกิดโดยประมาณ
   *   เลือกทางนี้เพราะ "อายุ" ที่เก็บเป็นตัวเลขจะผิดเองเงียบ ๆ ทุกปีที่ผ่านไป
   *   ถ้าสรุปว่าต้องเก็บอายุดิบ ให้แก้ที่ ageToDateOfBirth / dateOfBirthToAge
   *   ใน patient-profile.mapper.ts สองฟังก์ชันเท่านั้น
   */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(130)
  @Type(() => Number)
  age?: number;

  @IsOptional()
  @IsIn(GENDER_LABELS as unknown as string[])
  gender?: GenderLabel;

  /** น้ำหนัก (กก.) — DB weight_kg NUMERIC(5,2) → เพดาน 999.99 */
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(999.99)
  @Type(() => Number)
  weight?: number;

  /** ส่วนสูง (ซม.) — DB height_cm NUMERIC(5,2) */
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(999.99)
  @Type(() => Number)
  height?: number;

  @IsOptional()
  @IsIn(SUPPORT_LEVEL_LABELS as unknown as string[])
  supportLevel?: SupportLevelLabel;

  /** กรุ๊ปเลือด — DB blood_type VARCHAR(5) */
  @IsOptional()
  @IsString()
  @MaxLength(5)
  bloodGroup?: string;

  /**
   * โรคประจำตัว — DB medical_conditions TEXT[]
   * FE มีปุ่มสำเร็จรูป 4 โรค + พิมพ์เองได้ → ไม่จำกัดชุดค่า จำกัดแค่จำนวนกับความยาว
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  conditions?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  medicines?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  allergies?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  careInstructions?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  regularHospital?: string;
}
