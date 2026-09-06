import { Field, Float, ID, InputType } from '@nestjs/graphql';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsLatitude,
  IsLongitude,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * PYG-424 — input ของ mutation createBookingOnBehalf
 *
 * ★ ทำไมไม่ reuse CreateBookingDto ของ REST ตรง ๆ?
 *   ตัวนั้นเป็น DTO ของ REST ล้วน ๆ (ไม่มี @Field) ถ้าเอามาแปะ @InputType ทับ
 *   ทุกฟิลด์ที่ REST เพิ่มในอนาคตจะโผล่ใน GraphQL schema เองแบบเงียบ ๆ
 *   รวมถึงฟิลด์ที่ไม่ควรให้คนจองแทนกรอก → แยกไฟล์ชัดเจนกว่า และ FE อ่าน schema แล้วเข้าใจตรง
 *
 * ★ ฟิลด์ที่ "จงใจไม่มี" ในนี้:
 *   - patientName    ชื่อคนไข้มาจากโปรไฟล์ผู้รับบริการอยู่แล้ว ให้กรอกซ้ำจะขัดกันเอง
 *   - memberDetails  รอ PYG-426 (ดีไซน์ฟอร์ม FG-4) + repo ยังไม่มี graphql-type-json
 *                    คอลัมน์ member_details เป็น nullable → เติมทีหลังได้ ไม่ต้องแก้ migration
 */
@InputType()
export class CreateBookingOnBehalfInput {
  @Field(() => ID, {
    description: 'กลุ่มครอบครัวที่ใช้จอง — ผู้เรียกต้องเป็นสมาชิก ACTIVE ของกลุ่มนี้',
  })
  @IsUUID()
  groupId: string;

  @Field(() => ID, {
    description:
      'โปรไฟล์ผู้รับบริการที่จองให้ — ต้องถูกแชร์อยู่ในกลุ่มนี้ ไม่งั้นได้ RECIPIENT_NOT_IN_GROUP. ★ บังคับกรอก ต่างจากการจองปกติ เพราะ "จองแทน" แปลว่าต้องมีคนที่ถูกจองให้เสมอ',
  })
  @IsUUID()
  careRecipientId: string;

  @Field(() => ID, {
    nullable: true,
    description: 'ผู้ดูแลที่เลือกไว้ — ส่งมา = booking เป็น pending ทันที, ไม่ส่ง = unmatched รอ matching',
  })
  @IsOptional()
  @IsUUID()
  caregiverId?: string;

  @Field(() => [String], { description: 'รายการงาน เช่น ["อาบน้ำ", "ป้อนอาหาร"] อย่างน้อย 1 รายการ' })
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  tasks: string[];

  @Field(() => [String], { description: 'สถานที่ให้บริการ เช่น ["บ้าน"] อย่างน้อย 1 รายการ' })
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  serviceLocations: string[];

  @Field({ description: 'ประเภทบริการ เช่น "elderly_care"' })
  @IsString()
  @IsNotEmpty()
  serviceType: string;

  @Field({ description: 'ช่วงเวลา: "morning" | "afternoon" | "evening"' })
  @IsString()
  @IsNotEmpty()
  timeSlot: string;

  @Field({ description: 'เวลาเริ่ม รูปแบบ "09:00:00"' })
  @IsString()
  @IsNotEmpty()
  startTime: string;

  @Field(() => Float, { description: 'จำนวนชั่วโมง (ขั้นต่ำ 0.5)' })
  @IsNumber()
  @Min(0.5)
  @Type(() => Number)
  durationHours: number;

  @Field({ description: 'ที่อยู่จุดให้บริการ' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  locationAddress: string;

  /**
   * PYG-352: พิกัดจุดงาน — ระบบเช็คอินใช้คู่นี้คำนวณระยะ
   * ไม่ส่งมา = ไม่คำนวณระยะ และไม่ติดธง (ไม่ลงโทษผู้ดูแลจากข้อมูลที่เราเองไม่มี)
   */
  @Field(() => Float, { nullable: true, description: 'ละติจูดจุดงาน (จากหมุดบนแผนที่)' })
  @IsOptional()
  @IsNumber()
  @IsLatitude()
  @Type(() => Number)
  lat?: number;

  @Field(() => Float, { nullable: true, description: 'ลองจิจูดจุดงาน (จากหมุดบนแผนที่)' })
  @IsOptional()
  @IsNumber()
  @IsLongitude()
  @Type(() => Number)
  lng?: number;

  @Field({ description: 'วันที่ให้บริการ รูปแบบ ISO: "2026-09-15"' })
  @IsDateString()
  bookingDate: string;

  @Field({ nullable: true, description: 'ชื่อผู้ติดต่อวันให้บริการ' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  dayOfContactName?: string;

  @Field({ nullable: true, description: 'เบอร์ผู้ติดต่อวันให้บริการ' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  dayOfContactPhone?: string;

  @Field({ nullable: true, description: 'ความสัมพันธ์ของผู้ติดต่อกับผู้รับบริการ' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  dayOfContactRelationship?: string;

  @Field({ nullable: true, description: 'บันทึกเพิ่มเติมถึงผู้ดูแล' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}
