import { InputType, Field, Float, ID } from '@nestjs/graphql';
import {
  IsEmail,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  Matches,
  MinLength,
  ValidateIf,
} from 'class-validator';

@InputType()
export class AdminUpdateCaregiverInfoInput {
  @Field(() => ID, { description: 'UUID of the caregiver to edit' })
  @IsUUID('4')
  caregiverId: string;

  @Field({ nullable: true, description: 'First name' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  firstName?: string;

  @Field({ nullable: true, description: 'Last name' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  lastName?: string;

  @Field({
    nullable: true,
    description: 'Thai national ID (exactly 13 digits)',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d{13}$/, { message: 'idCardNumber must be exactly 13 digits' })
  idCardNumber?: string;

  @Field({ nullable: true, description: 'Email address (must be unique)' })
  @IsOptional()
  @IsEmail()
  email?: string;

  /**
   * ค่าบริการต่อชั่วโมง (บาท) — PYG-534
   *
   * ตั้งแต่ PYG-534 ผู้ดูแลตั้งราคาเองไม่ได้แล้ว → ทางนี้คือทางเดียวที่เหลือในระบบ
   * ใช้ชั่วคราวจนกว่า Catalog ราคาของ PYG-487 จะพร้อม
   *
   * กติกา:
   * - ไม่ส่ง = ไม่แตะราคาเดิม
   * - ต้อง > 0 — payment.service ปฏิเสธราคา <= 0 (422) ตั้ง 0 = ผู้ดูแลคนนั้นรับเงินไม่ได้เลย
   * - ส่ง null ไม่ได้ — ยังไม่มีเคส "ล้างราคา" (ราคากลางสำหรับค่าว่างเป็นงานของ PYG-535)
   *
   * ทำไมใช้ @ValidateIf แทน @IsOptional: @IsOptional ปล่อย null ผ่านด้วย
   * แล้ว service จะเขียน null ทับราคาเดิม ValidateIf ข้ามเฉพาะตอน "ไม่ส่งมา" เท่านั้น
   */
  @Field(() => Float, {
    nullable: true,
    description:
      'Hourly rate in THB (must be > 0). Only admins can set this since PYG-534',
  })
  @ValidateIf((_, value) => value !== undefined)
  @IsNumber(
    { allowNaN: false, allowInfinity: false, maxDecimalPlaces: 2 },
    { message: 'ค่าบริการต้องเป็นตัวเลข ทศนิยมไม่เกิน 2 ตำแหน่ง' },
  )
  @IsPositive({ message: 'ค่าบริการต้องมากกว่า 0 บาท' })
  hourlyRate?: number;
}
