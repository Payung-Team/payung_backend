/**
 * RejectKycInput — Input สำหรับ mutation rejectKyc
 *
 * Validation:
 * - caregiverId : UUID ของ caregiver ที่จะ reject (required)
 * - reason      : เหตุผลที่ reject ต้องมีอย่างน้อย 10 ตัวอักษร
 *                 เพื่อให้ caregiver ได้รับข้อมูลเพียงพอสำหรับการแก้ไข
 */
import { InputType, Field, ID } from '@nestjs/graphql';
import { IsNotEmpty, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

@InputType()
export class RejectKycInput {
  /** UUID ของ caregiver ที่ต้องการ reject */
  @Field(() => ID, { description: 'UUID of the caregiver to reject' })
  @IsUUID('4', { message: 'caregiverId ต้องเป็น UUID ที่ถูกต้อง' })
  caregiverId!: string;

  /**
   * เหตุผลที่ reject — จำเป็นสำหรับแจ้ง caregiver ให้แก้ไขได้ถูกต้อง
   * - ต้องมีอย่างน้อย 10 ตัวอักษร (เพื่อให้มีความหมายเพียงพอ)
   * - สูงสุด 500 ตัวอักษร
   */
  @Field({ description: 'Reason for rejection (min 10 chars). Will be sent to caregiver via notification and email.' })
  @IsString({ message: 'reason ต้องเป็นข้อความ' })
  @IsNotEmpty({ message: 'กรุณาระบุเหตุผลที่ reject' })
  @MinLength(10, { message: 'เหตุผลต้องมีอย่างน้อย 10 ตัวอักษร' })
  @MaxLength(500, { message: 'เหตุผลต้องไม่เกิน 500 ตัวอักษร' })
  reason!: string;
}
