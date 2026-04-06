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
 * - skills: array ต้องมีอย่างน้อย 1 รายการ
 * - experienceYears: จำนวนเต็ม >= 0
 * - hourlyRate: ตัวเลข >= 0
 * - bio: optional, สูงสุด 500 ตัวอักษร
 * - documentIds: array ของ UUID
 *
 * Error messages เป็นภาษาไทย ตาม AC ของ PYG-63
 */
import { InputType, Field, Int, Float } from '@nestjs/graphql';
import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { ValidThaiId } from '../../../common/validators/valid-thai-id.validator';
import { ValidThaiPhone } from '../../../common/validators/valid-thai-phone.validator';

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
   * ทักษะของ caregiver — ต้องมีอย่างน้อย 1 รายการ
   * ตัวอย่าง: ["elder_care", "first_aid", "medication_management"]
   */
  @Field(() => [String], { description: 'List of caregiver skills' })
  @IsArray({ message: 'ทักษะต้องเป็น array' })
  @ArrayMinSize(1, { message: 'กรุณาเลือกทักษะอย่างน้อย 1 รายการ' })
  @IsString({ each: true, message: 'ทักษะแต่ละรายการต้องเป็นข้อความ' })
  skills!: string[];

  /**
   * จำนวนปีประสบการณ์ — ต้องเป็นจำนวนเต็ม >= 0
   */
  @Field(() => Int, { description: 'Years of caregiving experience' })
  @IsInt({ message: 'จำนวนปีประสบการณ์ต้องเป็นจำนวนเต็ม' })
  @Min(0, { message: 'จำนวนปีประสบการณ์ต้องไม่น้อยกว่า 0' })
  experienceYears!: number;

  /**
   * ค่าบริการต่อชั่วโมง (บาท) — ต้อง >= 0
   */
  @Field(() => Float, { description: 'Hourly rate in THB' })
  @IsNumber({}, { message: 'ค่าบริการต้องเป็นตัวเลข' })
  @Min(0, { message: 'ค่าบริการต้องไม่น้อยกว่า 0 บาท' })
  hourlyRate!: number;

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
}
