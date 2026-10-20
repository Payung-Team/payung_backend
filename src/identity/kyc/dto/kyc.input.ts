/* eslint-disable @typescript-eslint/no-unsafe-call */
/**
 * KycInput — DTO (Data Transfer Object) สำหรับ submitKyc mutation
 *
 * DTO คืออะไร?
 * - คือ "แบบฟอร์ม" ที่กำหนดว่า client (frontend) ต้องส่งข้อมูลอะไรมา
 * - @InputType() = บอก GraphQL ว่านี่คือ "input" (ข้อมูลขาเข้า)
 *   ต่างจาก @ObjectType() ที่เป็น "output" (ข้อมูลขาออก)
 * - class-validator decorators ตรวจสอบข้อมูลก่อนส่งถึง Service เสมอ
 *   ถ้าไม่ผ่านจะ throw BadRequestException อัตโนมัติ
 *
 * Validation rules (PYG-64):
 * - fullName: 2-100 ตัวอักษร
 * - idCardNumber: เลขบัตรประชาชนไทย 13 หลัก + check digit
 * - phone: เบอร์โทรไทย (0xx-xxx-xxxx)
 * - skills: รหัสกลาง (care_skills) อย่างน้อย 1 รายการ — service ตรวจรหัสและวิชาชีพ (PYG-652)
 * - otherSkills: optional, ข้อความอิสระไม่เกิน 5 รายการ (ตัดช่องว่าง/ค่าซ้ำให้) (PYG-652)
 * - experienceYears: จำนวนเต็ม >= 0
 * - hourlyRate: deprecated (PYG-536) — optional และไม่ถูกบันทึก
 * - bio: optional, สูงสุด 500 ตัวอักษร
 * - documentIds: array ของ UUID
 * - profession: บังคับตาม contract (PYG-573) แต่ตรวจที่ KycService — ดูเหตุผลที่ field
 *
 * Error messages เป็นภาษาไทย ตาม AC ของ PYG-63
 */
import { InputType, Field, Int, Float } from '@nestjs/graphql';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsDate,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ValidThaiId } from '../../../common/validators/valid-thai-id.validator';
import { ValidThaiPhone } from '../../../common/validators/valid-thai-phone.validator';
import { PayoutAccountInput } from './payout-account.input';
import { TransportMode } from '../driving-license/transport-mode';
import {
  OTHER_SKILLS_MAX,
  OTHER_SKILL_MAX_LENGTH,
  normalizeOtherSkills,
} from '../../../care-skill/care-skill.constants';

@InputType()
export class KycInput {
  /**
   * ชื่อ-นามสกุลจริง — ต้องตรงกับบัตรประชาชน
   * - ต้องมีอย่างน้อย 2 ตัวอักษร (เช่น "สม")
   * - สูงสุด 100 ตัวอักษร
   */
  @Field({ description: 'Full legal name (must match ID card)' })
  @IsString({ message: 'ชื่อต้องเป็นข้อความ' })
  @IsNotEmpty({ message: 'กรุณากรอกชื่อ-นามสกุล' })
  @MinLength(2, { message: 'ชื่อต้องมีอย่างน้อย 2 ตัวอักษร' })
  @MaxLength(100, { message: 'ชื่อต้องไม่เกิน 100 ตัวอักษร' })
  fullName!: string;

  /**
   * เลขบัตรประชาชนไทย 13 หลัก
   * - ต้องเป็นตัวเลข 13 หลัก
   * - check digit (หลักที่ 13) ต้องถูกต้อง
   */
  @Field({ description: 'Thai national ID card number (13 digits)' })
  @IsString({ message: 'เลขบัตรประชาชนต้องเป็นข้อความ' })
  @IsNotEmpty({ message: 'กรุณากรอกเลขบัตรประชาชน' })
  @ValidThaiId({ message: 'เลขบัตรประชาชนไม่ถูกต้อง (ต้องเป็นตัวเลข 13 หลักที่ถูกต้อง)' })
  idCardNumber!: string;

  /**
   * เบอร์โทรศัพท์ — รองรับ format ไทย
   * - 0812345678, 081-234-5678 (มือถือ)
   * - 021234567, 02-123-4567 (บ้าน)
   */
  @Field({ description: 'Contact phone number (Thai format)' })
  @IsString({ message: 'เบอร์โทรต้องเป็นข้อความ' })
  @IsNotEmpty({ message: 'กรุณากรอกเบอร์โทรศัพท์' })
  @ValidThaiPhone({ message: 'เบอร์โทรศัพท์ไม่ถูกต้อง (เช่น 081-234-5678)' })
  phone!: string;

  /**
   * ทักษะของ caregiver — รหัสกลางจาก careSkills(profession) อย่างน้อย 1 รายการ
   * ตัวอย่าง: ["transfer_assist", "bathing", "dementia_care"]
   * service ตรวจซ้ำว่าทุกรหัสมีใน care_skills และวิชาชีพของผู้ดูแลถือได้ (PYG-652)
   */
  @Field(() => [String], {
    description: 'Central skill codes from careSkills(profession)',
  })
  @IsArray({ message: 'ทักษะต้องเป็น array' })
  @ArrayMinSize(1, { message: 'กรุณาเลือกทักษะอย่างน้อย 1 รายการ' })
  @IsString({ each: true, message: 'ทักษะแต่ละรายการต้องเป็นข้อความ' })
  skills!: string[];

  /**
   * ทักษะอื่น ๆ ที่ไม่อยู่ในรายการกลาง — ข้อความอิสระ สูงสุด 5 รายการ (PYG-652)
   * ตัดช่องว่างหัวท้าย ทิ้งค่าว่าง และตัดค่าซ้ำให้ก่อนตรวจ
   * ไม่ส่งมา = ยื่นครั้งแรกเป็น [] · ยื่นซ้ำคงค่าเดิมไว้
   */
  @Field(() => [String], {
    nullable: true,
    description: `Free-text skills not in the central list (max ${OTHER_SKILLS_MAX}; trimmed, de-duplicated)`,
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

  /**
   * จำนวนปีประสบการณ์ — ต้องเป็นจำนวนเต็ม >= 0
   */
  @Field(() => Int, { description: 'Years of caregiving experience' })
  @IsInt({ message: 'จำนวนปีประสบการณ์ต้องเป็นจำนวนเต็ม' })
  @Min(0, { message: 'จำนวนปีประสบการณ์ต้องไม่น้อยกว่า 0' })
  experienceYears!: number;

  /**
   * @deprecated PYG-536 — ผู้ดูแลตั้งราคาเองไม่ได้แล้ว ส่งมาได้แต่ระบบไม่บันทึก (เหมือน UpdateCaregiverInput / PYG-534)
   *
   * - เปลี่ยนเป็น optional: FE รุ่นใหม่เลิกส่งแล้ว ถ้ายังเป็น Float! GraphQL จะตอบ 400 ทั้ง request
   * - ยังไม่ลบ field: FE รุ่นเก่าที่ยังส่งมาจะได้ไม่โดน "Unknown field"
   * - เหลือ decorator ไว้เพราะ ValidationPipe ตั้ง forbidNonWhitelisted
   * - ไม่มี @Min(0): ค่านี้ถูกทิ้งอยู่แล้ว ไม่ควรทำให้ KYC ส่งไม่ผ่าน
   */
  @Field(() => Float, {
    nullable: true,
    deprecationReason:
      'PYG-536: ผู้ดูแลตั้งราคาเองไม่ได้แล้ว — ส่งมาได้แต่ระบบไม่บันทึก (ช่วงเปลี่ยนผ่าน)',
    description: 'Hourly rate in THB (deprecated — ignored)',
  })
  @IsOptional()
  @IsNumber({}, { message: 'ค่าบริการต้องเป็นตัวเลข' })
  hourlyRate?: number;

  /**
   * เพศ — optional
   * ค่าที่รับได้: "male", "female", "other"
   */
  @Field({ nullable: true, description: 'Gender: male | female | other' })
  @IsOptional()
  @IsString({ message: 'เพศต้องเป็นข้อความ' })
  @IsIn(['male', 'female', 'other'], { message: 'เพศต้องเป็น male, female หรือ other' })
  gender?: string;

  /**
   * วันเกิด — optional
   */
  @Field({ nullable: true, description: 'Date of birth' })
  @IsOptional()
  @IsDate({ message: 'วันเกิดต้องเป็นวันที่ที่ถูกต้อง' })
  dateOfBirth?: Date;

  /**
   * แนะนำตัวสั้นๆ — optional, สูงสุด 500 ตัวอักษร
   */
  @Field({ nullable: true, description: 'Short bio / introduction' })
  @IsOptional()
  @IsString({ message: 'bio ต้องเป็นข้อความ' })
  @MaxLength(500, { message: 'bio ต้องไม่เกิน 500 ตัวอักษร' })
  bio?: string;

  /**
   * รายการ document IDs ที่อัปโหลดไว้แล้ว
   * แต่ละ ID ต้องเป็น UUID v4 ที่ถูกต้อง
   */
  @Field(() => [String], {
    description: 'IDs of previously uploaded KYC documents',
  })
  @IsArray({ message: 'documentIds ต้องเป็น array' })
  @IsUUID('4', { each: true, message: 'document ID แต่ละตัวต้องเป็น UUID ที่ถูกต้อง' })
  documentIds!: string[];

  /**
   * วิชาชีพ (PYG-556 · S01-AC1) — "บังคับ" ตาม contract แต่ใน schema เป็น String nullable โดยตั้งใจ
   *
   * ทำไมไม่ใช่ `CaregiverProfession!`?
   * - ถ้าบังคับที่ schema client เก่าที่ไม่ส่งค่าจะโดน GraphQL ปฏิเสธเองด้วย BAD_USER_INPUT (HTTP 400)
   *   ก่อนถึงโค้ดของเรา → FE ไม่ได้ code PROFESSION_REQUIRED ตามที่ตกลง (S01-E3)
   * - ถ้าเป็น enum ค่าผิดก็โดนปฏิเสธแบบเดียวกัน → ไม่ได้ PROFESSION_INVALID (S01-E4)
   * - บทเรียนเดียวกับ PYG-415 (decorator ใน DTO ตอบ BAD_REQUEST ก่อนถึงตัวเช็คใน service)
   * กติกาจริงอยู่ที่ parseProfessionInput() ซึ่ง KycService เรียกเป็นอย่างแรก
   * decorator ที่เหลือมีไว้ให้ผ่าน forbidNonWhitelisted เท่านั้น
   */
  @Field({
    nullable: true,
    description:
      'Required — general_caregiver | nurse | physiotherapist (missing = PROFESSION_REQUIRED)',
  })
  @IsOptional()
  @IsString({ message: 'วิชาชีพต้องเป็นข้อความ' })
  profession?: string;

  /**
   * PYG-597: ขับรถรับส่งเอง - true = ต้องมีใบขับขี่ (DRIVING_LICENSE_REQUIRED / _EXPIRY_REQUIRED / _EXPIRED)
   * false = ไม่บังคับ (ไม่รับส่ง / ใช้รถรับจ้าง) · ไม่ส่ง = ไม่ตรวจและ BE ไม่ตีความเป็น false (E10 รอ contract)
   * PYG-661: ใช้เมื่อไม่ส่ง transportMode — true บันทึกเป็น self_drive · false ไม่เขียนค่า (แยก hired_ride กับ none ไม่ได้ · E10)
   * ถ้าส่งคู่กับ transportMode ต้องไม่ขัดกัน (TRANSPORT_MODE_CONFLICT 422)
   */
  @Field(() => Boolean, {
    nullable: true,
    description: 'Legacy answer: true = SELF_DRIVE; false is not persisted (cannot tell HIRED_RIDE from NONE). Prefer transportMode.',
  })
  @IsOptional()
  @IsBoolean({ message: 'selfDriveTransport ต้องเป็น true หรือ false' })
  selfDriveTransport?: boolean;

  /**
   * PYG-661: วิธีเดินทางรับส่ง — SELF_DRIVE ต้องมีใบขับขี่ใน documentIds รอบนี้ · บันทึกลง caregivers.transport_mode
   * ไม่ส่ง = ไม่แตะค่าเดิม (E10: ไม่ตีความเป็น none)
   */
  @Field(() => TransportMode, { nullable: true, description: 'SELF_DRIVE | HIRED_RIDE | NONE (optional)' })
  @IsOptional()
  @IsEnum(TransportMode, { message: 'transportMode ไม่ถูกต้อง' })
  transportMode?: TransportMode;

  /**
   * บัญชีธนาคารรับเงิน (PYG-266) — optional (frontend เดิมยังไม่มีฟอร์มนี้)
   * ถ้าส่งมาต้องกรอกครบทั้ง 3 field (all-or-nothing — ดู PayoutAccountInput)
   */
  @Field(() => PayoutAccountInput, {
    nullable: true,
    description: 'Payout bank account (optional)',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => PayoutAccountInput)
  payoutAccount?: PayoutAccountInput;
}
