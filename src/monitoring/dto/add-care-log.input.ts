import { Field, ID, InputType } from '@nestjs/graphql';
import {
  IsIn,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { CARE_LOG_CATEGORY_VALUES } from '../monitoring.constants';

/**
 * AddCareLogInput — ผู้ดูแลบันทึก "อัปเดตจากผู้ดูแล" 1 รายการระหว่างปฏิบัติงาน (PYG-361)
 *
 * ★ display-only: ไม่มีผลต่อ proofOfWork.verdict หรือการปล่อยเงินใด ๆ ทั้งสิ้น
 */
@InputType()
export class AddCareLogInput {
  @Field(() => ID, {
    description: 'booking ที่จะบันทึก — ต้องเป็นงานของผู้ดูแลคนนี้และอยู่ระหว่างเช็คอิน (in_progress)',
  })
  @IsUUID()
  bookingId: string;

  @Field({ description: "หมวดหมู่: 'vitals' | 'food' | 'medication' | 'activity' | 'other'" })
  @IsIn(CARE_LOG_CATEGORY_VALUES, { message: 'หมวดหมู่ไม่ถูกต้อง' })
  category: string;

  @Field({ description: 'เนื้อหาบันทึก ไม่เกิน 500 ตัวอักษร' })
  @IsNotEmpty({ message: 'ข้อความยาวเกินกำหนด' })
  @MaxLength(500, { message: 'ข้อความยาวเกินกำหนด' })
  body: string;

  @Field({
    nullable: true,
    description:
      "รูปประกอบ (ไม่บังคับ) — ต้องเป็นไฟล์ใน bucket 'job-evidence' ใต้โฟลเดอร์ของ booking นี้เท่านั้น URL จากที่อื่นจะถูกปฏิเสธ",
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  photoUrl?: string;

  @Field({
    nullable: true,
    description: 'เวลาที่เครื่อง client อ้าง (ISO 8601) — เก็บเป็น metadata เท่านั้น เวลาจริงใช้ของเซิร์ฟเวอร์เสมอ',
  })
  @IsOptional()
  @IsISO8601()
  deviceTs?: string;
}
