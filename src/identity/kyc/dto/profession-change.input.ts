/**
 * Input ของคำขอเปลี่ยนวิชาชีพ (PYG-556 · S01-AC6 · contract PYG-573 §4)
 */
import { Field, ID, InputType, Int } from '@nestjs/graphql';
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ProfessionChangeStatus } from '../profession.constants';

/** ผู้ดูแลยื่นคำขอ — ชื่อ type ตรงกับ `$input: ProfessionChangeInput!` ใน FE */
@InputType()
export class ProfessionChangeInput {
  /**
   * String ไม่ใช่ enum โดยตั้งใจ — ให้ค่าผิดไปถึง parseProfessionInput แล้วได้ PROFESSION_INVALID ตาม contract
   * (ถ้าเป็น enum, GraphQL ปฏิเสธเองก่อนด้วย BAD_USER_INPUT ทั่วไป)
   * S03 (PYG-558) จะเพิ่ม licenseDocumentId / licenseNumber / licenseExpiresAt ที่นี่ (เพิ่มอย่างเดียว ไม่ breaking)
   */
  @Field({ description: 'general_caregiver | nurse | physiotherapist' })
  @IsString({ message: 'วิชาชีพต้องเป็นข้อความ' })
  profession!: string;
}

/** คิวตรวจของแอดมิน */
@InputType()
export class AdminProfessionChangeRequestsInput {
  /** ไม่ส่ง = pending (คิวรอตรวจ เรียงเก่าสุดก่อน) */
  @Field(() => ProfessionChangeStatus, {
    nullable: true,
    defaultValue: ProfessionChangeStatus.pending,
  })
  @IsOptional()
  @IsEnum(ProfessionChangeStatus)
  status?: ProfessionChangeStatus;

  @Field(() => Int, { nullable: true, defaultValue: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  page?: number;

  @Field(() => Int, { nullable: true, defaultValue: 20 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}

/** แอดมินปฏิเสธคำขอ — กติกาของ reason เหมือน RejectProfilePhotoInput */
@InputType()
export class RejectProfessionChangeInput {
  @Field(() => ID)
  @IsUUID('4', { message: 'id ของคำขอไม่ถูกต้อง' })
  id!: string;

  @Field({ description: 'เหตุผลที่แสดงให้ผู้ดูแลเห็น (บังคับ)' })
  @IsString({ message: 'reason ต้องเป็นข้อความ' })
  @IsNotEmpty({ message: 'ต้องระบุเหตุผลที่ปฏิเสธ' })
  @MaxLength(500, { message: 'เหตุผลต้องไม่เกิน 500 ตัวอักษร' })
  reason!: string;
}
