/**
 * PYG-498 — input ของ mutation completeOnboarding
 *
 * ★ ทำไมต้องมี PatientProfileInput แยกจาก PatientProfileDto ของ src/patient/
 *   ตัวนั้นเป็น DTO ของ REST (class-validator ล้วน ไม่มี @Field) GraphQL จึงมองไม่เห็น
 *   ถ้าไปแปะ @InputType ทับตัวเดิม ทุกฟิลด์ที่ REST เพิ่มในอนาคตจะโผล่ใน GraphQL schema
 *   เองแบบเงียบ ๆ และที่สำคัญกว่านั้น — เส้นทาง Booking ใช้ DTO ตัวนั้นอยู่
 *   การแตะมันคือการเสี่ยงทำให้ "จองไม่ผ่าน" ในเคสที่วันนี้จองผ่าน
 *
 *   ที่นี่จึงประกาศฟิลด์ซ้ำเพื่อบอก GraphQL แต่ **ใช้ validator ชุดเดียวกัน** และ
 *   `implements PatientProfileDto` ให้ TS เป็นคนจับถ้าสองฝั่งหลุดจากกัน
 *   ส่วนการแปลงเป็นคอลัมน์ยังใช้ `toCareRecipientColumns` ตัวเดิม ไม่เขียน mapping ใหม่
 *
 * ★ ช่องบังคับของ Onboarding (age / gender / supportLevel) บังคับ "ที่นี่" ไม่ใช่ใน DTO เดิม
 *   DTO เดิมตั้งใจให้ทุกฟิลด์ optional เพราะ BE ไม่อยากบล็อกการจอง (ดูคอมเมนต์ในไฟล์นั้น)
 *   แต่ Onboarding ต่างกัน: ถ้าปล่อยให้ข้าม 3 ช่องนี้ `onboardingCompleted` จะไม่มีวันเป็น true
 *   ผู้ใช้จะโดนเด้งกลับมาหน้าเดิมวนไม่จบ — บังคับตรงนี้จึงเป็นคนละเรื่องกับการบล็อกการจอง
 */
import { Field, InputType, Int } from '@nestjs/graphql';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { ConsentAnswerInput } from '../../../consent/dto/consent-answer.input';
import {
  GENDER_LABELS,
  type GenderLabel,
  PatientProfileDto,
  SUPPORT_LEVEL_LABELS,
  type SupportLevelLabel,
} from '../../../patient/dto/patient-profile.dto';

/** ชื่อ/นามสกุลยาวสุด 100 — ตรงกับ users.first_name / last_name VARCHAR(100) ของ PYG-497 */
export const ONBOARDING_NAME_MAX_LENGTH = 100;

@InputType({ description: 'ข้อมูลสุขภาพผู้รับบริการ — ชุดเดียวกับฟอร์มเลือกผู้เข้ารับบริการ' })
export class PatientProfileInput implements PatientProfileDto {
  /** อายุเป็นปี — บังคับใน Onboarding (DB เก็บเป็น date_of_birth) */
  @Field(() => Int, { description: 'อายุเป็นปี 0-130' })
  @IsInt()
  @Min(0)
  @Max(130)
  @Type(() => Number)
  age!: number;

  @Field({ description: 'เพศ — "ชาย" หรือ "หญิง"' })
  @IsIn(GENDER_LABELS as unknown as string[])
  gender!: GenderLabel;

  @Field({ description: 'ระดับการช่วยเหลือตัวเอง' })
  @IsIn(SUPPORT_LEVEL_LABELS as unknown as string[])
  supportLevel!: SupportLevelLabel;

  @Field(() => Number, { nullable: true, description: 'น้ำหนัก (กก.)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(999.99)
  @Type(() => Number)
  weight?: number;

  @Field(() => Number, { nullable: true, description: 'ส่วนสูง (ซม.)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(999.99)
  @Type(() => Number)
  height?: number;

  @Field({ nullable: true, description: 'กรุ๊ปเลือด' })
  @IsOptional()
  @IsString()
  @MaxLength(5)
  bloodGroup?: string;

  @Field(() => [String], { nullable: true, description: 'โรคประจำตัว' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  conditions?: string[];

  @Field({ nullable: true, description: 'ยาที่ทานประจำ' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  medicines?: string;

  @Field({ nullable: true, description: 'ยาที่แพ้ / อาหารที่แพ้' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  allergies?: string;

  @Field({ nullable: true, description: 'สิ่งที่ผู้ดูแลควรรู้เพิ่มเติม' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  careInstructions?: string;

  @Field({ nullable: true, description: 'โรงพยาบาลที่ใช้บริการประจำ' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  regularHospital?: string;
}

@InputType({ description: 'ข้อมูลที่ผู้สูงอายุกรอกตอน Onboarding (PYG-496)' })
export class CompleteOnboardingInput {
  @Field({ description: 'ชื่อจริง' })
  @IsString()
  @IsNotEmpty({ message: 'กรุณากรอกชื่อ' })
  @MaxLength(ONBOARDING_NAME_MAX_LENGTH)
  firstName!: string;

  @Field({ description: 'นามสกุล' })
  @IsString()
  @IsNotEmpty({ message: 'กรุณากรอกนามสกุล' })
  @MaxLength(ONBOARDING_NAME_MAX_LENGTH)
  lastName!: string;

  @Field({ nullable: true, description: 'ชื่อเล่น' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  nickname?: string;

  @Field(() => PatientProfileInput, { description: 'ข้อมูลสุขภาพของผู้รับบริการ' })
  @ValidateNested()
  @Type(() => PatientProfileInput)
  details!: PatientProfileInput;

  /**
   * PYG-538 — ความยินยอมที่ผู้ใช้กดบนหน้า Onboarding
   *
   * ★ ต้องมี `sensitive_health_data` ที่ granted = true ไม่งั้นปฏิเสธทั้งคำขอ
   *   ข้อมูลใน `details` เป็นข้อมูลอ่อนไหวตาม ม.26 — เก็บโดยไม่มีความยินยอมโดยชัดแจ้งไม่ได้
   *   และ "เก็บไปก่อนแล้วค่อยขอ" ก็ไม่ได้ เพราะความยินยอมต้องมาก่อนการเก็บเสมอ
   */
  @Field(() => [ConsentAnswerInput], {
    description: 'ความยินยอมจากหน้า Onboarding — ต้องมี sensitive_health_data ที่ granted = true',
  })
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => ConsentAnswerInput)
  consents!: ConsentAnswerInput[];
}
