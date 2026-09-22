/* eslint-disable @typescript-eslint/no-unsafe-call */
import { InputType, Field, Int } from '@nestjs/graphql';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEmail,
  IsIn,
  IsOptional,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { ConsentAnswerInput } from '../../../consent/dto/consent-answer.input';

@InputType()
export class RegisterInput {
  @Field()
  @IsEmail({}, { message: 'Invalid email format' })
  email!: string;

  @Field()
  @MinLength(8, { message: 'Password must be at least 8 characters' })
  password!: string;

  @Field(() => Int)
  @IsIn([1, 2], {
    message: 'Role must be 1 (patient) or 2 (caregiver)',
  })
  role!: number;

  /**
   * PYG-474 — ความยินยอม PDPA ที่ผู้ใช้กดบนหน้าสมัคร
   *
   * ส่งคำตอบของทุกข้อที่หน้าสมัครแสดง (ดึงจาก `consentPolicy(source: "register")`):
   *   terms_of_service (บังคับ) · privacy_policy (บังคับ) · marketing (ไม่บังคับ — ไม่ติ๊กก็ส่ง false มา)
   * `policyVersion` ต้องเป็นค่าจาก `consentPolicy.version` ห้าม hardcode ฝั่ง FE
   *
   * ★ ประกาศเป็น nullable ใน GraphQL โดยตั้งใจ แต่ **ในทางปฏิบัติต้องส่งเสมอ**
   *   ไม่ส่ง = ขาดข้อบังคับ → BE ตอบ `CONSENT_REQUIRED` และไม่สร้างบัญชี
   *   ถ้าประกาศเป็น non-null ([...]!) คำขอที่ลืมส่งจะโดน GraphQL validation ตีกลับด้วยข้อความ
   *   ภาษาอังกฤษทั่ว ๆ ไปที่ไม่มี code ให้ FE แยก — แบบนี้ FE ได้ code เดียวกันทุกกรณีที่ขาด
   */
  @Field(() => [ConsentAnswerInput], {
    nullable: true,
    description:
      'ความยินยอมจากหน้าสมัคร (consentPolicy source: register) — ต้องมี terms_of_service ' +
      'และ privacy_policy ที่ granted = true ไม่งั้นสมัครไม่ได้ (CONSENT_REQUIRED)',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => ConsentAnswerInput)
  consents?: ConsentAnswerInput[];
}
