/* eslint-disable @typescript-eslint/no-unsafe-call */
import { InputType, Field, Int, Float } from '@nestjs/graphql';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { ValidThaiPhone } from '../../../common/validators/valid-thai-phone.validator';
import {
  OTHER_SKILLS_MAX,
  OTHER_SKILL_MAX_LENGTH,
  normalizeOtherSkills,
} from '../../../care-skill/care-skill.constants';

/**
 * UpdateCaregiverInput — input สำหรับ updateCaregiverProfile mutation
 *
 * Whitelist fields: bio, skills, otherSkills, experienceYears, phone, address, languages
 * Locked fields (fullName, idCardNumber, gender, dateOfBirth) ไม่อยู่ใน DTO นี้
 * → GraphQL reject อัตโนมัติถ้า client ส่ง field ที่ไม่มีใน schema
 *
 * hourlyRate (PYG-534): ยังอยู่ใน DTO แต่ "ไม่มีผล" — service ไม่เขียนลงตาราง
 *
 * ทุก field optional — partial update (ส่งมาแค่ field ที่อยากเปลี่ยน)
 */
@InputType()
export class UpdateCaregiverInput {
  @Field({ nullable: true, description: 'Short bio / introduction' })
  @IsOptional()
  @IsString({ message: 'bio ต้องเป็นข้อความ' })
  @MaxLength(500, { message: 'bio ต้องไม่เกิน 500 ตัวอักษร' })
  bio?: string;

  /**
   * @deprecated PYG-534 — ผู้ดูแลตั้งราคาเองไม่ได้แล้ว ส่งมาได้แต่ระบบไม่บันทึก
   *
   * ทำไมยังไม่ลบ field ทิ้ง:
   * - FE รุ่นปัจจุบันยังส่ง hourlyRate มากับทุกครั้งที่กดบันทึกโปรไฟล์
   *   ถ้าลบ → GraphQL ตอบ "Unknown field" แล้วผู้ดูแลแก้ bio/ทักษะ/เบอร์โทรไม่ได้ไปด้วย
   * - ลบได้จริงหลัง FE เลิกส่ง (PYG-536) — ดูจาก log "caregiver.profile.hourly_rate_ignored"
   *
   * ทำไมเอา @Min(0) ออก: ค่านี้ถูกทิ้งอยู่แล้ว การตอบ 400 เพราะค่าที่ไม่ได้ใช้ ทำให้ field อื่นแก้ไม่ได้เปล่าๆ
   * ทำไมต้องเหลือ decorator ไว้: ValidationPipe ตั้ง whitelist + forbidNonWhitelisted
   *   property ที่ไม่มี decorator เลยจะโดนปฏิเสธทั้ง request
   */
  @Field(() => Float, {
    nullable: true,
    deprecationReason:
      'PYG-534: ผู้ดูแลตั้งราคาเองไม่ได้แล้ว — ส่งมาได้แต่ระบบไม่บันทึก (ช่วงเปลี่ยนผ่าน)',
    description: 'Hourly rate in THB (deprecated — ignored)',
  })
  @IsOptional()
  @IsNumber({}, { message: 'ค่าบริการต้องเป็นตัวเลข' })
  hourlyRate?: number;

  /** รหัสกลางจาก careSkills(profession) — service ตรวจกับ care_skills และวิชาชีพ (PYG-652) */
  @Field(() => [String], {
    nullable: true,
    description: 'Central skill codes from careSkills(profession)',
  })
  @IsOptional()
  @IsArray({ message: 'ทักษะต้องเป็น array' })
  @ArrayMinSize(1, { message: 'กรุณาเลือกทักษะอย่างน้อย 1 รายการ' })
  @IsString({ each: true, message: 'ทักษะแต่ละรายการต้องเป็นข้อความ' })
  skills?: string[];

  /**
   * ทักษะอื่น ๆ (ข้อความอิสระ) สูงสุด 5 รายการ — ตัดช่องว่าง ทิ้งค่าว่าง ตัดค่าซ้ำให้ก่อนตรวจ (PYG-652)
   * ส่ง [] = ล้างทั้งหมด · ไม่ส่ง = คงค่าเดิม
   */
  @Field(() => [String], {
    nullable: true,
    description: `Free-text skills not in the central list (max ${OTHER_SKILLS_MAX}; trimmed, de-duplicated). Send [] to clear.`,
  })
  @IsOptional()
  @Transform(({ value }) => normalizeOtherSkills(value))
  @IsArray({ message: 'ทักษะอื่น ๆ ต้องเป็น array' })
  @ArrayMaxSize(OTHER_SKILLS_MAX, {
    message: `ทักษะอื่น ๆ กรอกได้ไม่เกิน ${OTHER_SKILLS_MAX} รายการ`,
  })
  @IsString({ each: true, message: 'ทักษะอื่น ๆ แต่ละรายการต้องเป็นข้อความ' })
  @MaxLength(OTHER_SKILL_MAX_LENGTH, {
    each: true,
    message: `ทักษะอื่น ๆ แต่ละรายการยาวได้ไม่เกิน ${OTHER_SKILL_MAX_LENGTH} ตัวอักษร`,
  })
  otherSkills?: string[];

  @Field(() => Int, { nullable: true, description: 'Years of caregiving experience' })
  @IsOptional()
  @IsInt({ message: 'จำนวนปีประสบการณ์ต้องเป็นจำนวนเต็ม' })
  @Min(0, { message: 'จำนวนปีประสบการณ์ต้องไม่น้อยกว่า 0' })
  experienceYears?: number;

  @Field({ nullable: true, description: 'Contact phone number (Thai format)' })
  @IsOptional()
  @IsString({ message: 'เบอร์โทรต้องเป็นข้อความ' })
  @ValidThaiPhone({ message: 'เบอร์โทรศัพท์ไม่ถูกต้อง (เช่น 081-234-5678)' })
  phone?: string;

  @Field({ nullable: true, description: 'Address' })
  @IsOptional()
  @IsString({ message: 'ที่อยู่ต้องเป็นข้อความ' })
  address?: string;

  @Field(() => [String], { nullable: true, description: 'Languages spoken by caregiver' })
  @IsOptional()
  @IsArray({ message: 'ภาษาต้องเป็น array' })
  @IsString({ each: true, message: 'ภาษาแต่ละรายการต้องเป็นข้อความ' })
  languages?: string[];
}
