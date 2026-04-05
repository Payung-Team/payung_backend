/* eslint-disable @typescript-eslint/no-unsafe-call */
/**
 * KycInput — DTO (Data Transfer Object) สำหรับ submitKyc mutation
 *
 * DTO คืออะไร?
 * - คือ "แบบฟอร์ม" ที่กำหนดว่า client (frontend) ต้องส่งข้อมูลอะไรมา
 * - @InputType() = บอก GraphQL ว่านี่คือ "input" (ข้อมูลขาเข้า)
 *   ต่างจาก @ObjectType() ที่เป็น "output" (ข้อมูลขาออก)
 * - class-validator decorators (@IsString, @IsUUID ฯลฯ) ตรวจสอบข้อมูลก่อน
 *   ส่งถึง Service เสมอ — ถ้าไม่ผ่านจะ throw BadRequestException อัตโนมัติ
 */
import { InputType, Field, Int, Float } from '@nestjs/graphql';
import {
  IsArray,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';

@InputType()
export class KycInput {
  @Field({ description: 'Full legal name (must match ID card)' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  fullName!: string;

  @Field({ description: 'Thai national ID card number (13 digits)' })
  @IsString()
  @IsNotEmpty()
  idCardNumber!: string;

  @Field({ description: 'Contact phone number' })
  @IsString()
  @IsNotEmpty()
  phone!: string;

  @Field(() => [String], { description: 'List of caregiver skills' })
  @IsArray()
  @IsString({ each: true })
  skills!: string[];

  @Field(() => Int, { description: 'Years of caregiving experience' })
  @IsInt()
  @Min(0)
  experienceYears!: number;

  @Field(() => Float, { description: 'Hourly rate in THB' })
  @IsNumber()
  @Min(0)
  hourlyRate!: number;

  @Field({ nullable: true, description: 'Short bio / introduction' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  bio?: string;

  @Field(() => [String], {
    description: 'IDs of previously uploaded KYC documents',
  })
  @IsArray()
  @IsUUID('4', { each: true, message: 'Each documentId must be a valid UUID' })
  documentIds!: string[];
}
