/* eslint-disable @typescript-eslint/no-unsafe-call */
/**
 * Work Condition inputs — PYG-188
 *
 * Input types สำหรับ mutation `updateWorkCondition` ซึ่ง "upsert" เงื่อนไขการทำงาน
 * ของ caregiver 3 ส่วน:
 *   1. availability  — ตารางว่างรายสัปดาห์ (วัน + ช่วงเวลา + เปิด/ปิด)
 *   2. jobTypes      — ประเภทงานที่รับ (array ของ string)
 *   3. serviceArea   — พื้นที่ให้บริการ (จังหวัด + อำเภอ/เขต)
 *
 * Partial-update semantics:
 *   - ถ้า client "ไม่ส่ง" section ไหนมา (undefined) → ไม่แตะ section นั้น (คงค่าเดิม)
 *   - ถ้า client ส่ง array ว่าง [] มา → ถือว่า "ล้างค่า" section นั้น (ลบทั้งหมด)
 *   ทำให้ FE บันทึกทีละส่วนได้ โดยไม่ต้องส่งทั้งหน้าเสมอ
 *
 * หมายเหตุ field naming: ใช้ camelCase (dayOfWeek/timeSlot/isActive) ตาม convention
 * ของ GraphQL ทั้งโปรเจกต์ — ต่างจาก spec ในตั๋ว (snake_case) ที่อิงสไตล์ REST/DB
 */
import { InputType, Field, Int } from '@nestjs/graphql';
import {
  IsArray,
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * AvailabilitySlotInput — 1 ช่องในตารางว่าง (1 วัน × 1 ช่วงเวลา)
 *
 * map ตรงกับ Prisma model `CaregiverAvailability` (dayOfWeek/timeSlot/isActive)
 */
@InputType()
export class AvailabilitySlotInput {
  // dayOfWeek เก็บเป็นตัวเลข 0–6 ตาม convention ของ JavaScript Date.getDay()
  // (0 = อาทิตย์, 1 = จันทร์, …, 6 = เสาร์) — FE เป็นฝั่งจัดลำดับการแสดงผลเอง
  @Field(() => Int, { description: 'Day of week: 0=Sunday, 1=Monday … 6=Saturday' })
  @IsInt({ message: 'dayOfWeek ต้องเป็นจำนวนเต็ม' })
  @Min(0, { message: 'dayOfWeek ต้องอยู่ระหว่าง 0–6' })
  @Max(6, { message: 'dayOfWeek ต้องอยู่ระหว่าง 0–6' })
  dayOfWeek!: number;

  // timeSlot เป็น string อิสระ เพื่อให้ยืดหยุ่นเหมือน booking.timeSlot
  // ค่าที่ใช้จริงตาม design: 'morning' | 'afternoon' | 'evening'
  @Field({ description: "Time slot label e.g. 'morning' | 'afternoon' | 'evening'" })
  @IsString({ message: 'timeSlot ต้องเป็นข้อความ' })
  @IsNotEmpty({ message: 'timeSlot ห้ามว่าง' })
  @MaxLength(30, { message: 'timeSlot ต้องไม่เกิน 30 ตัวอักษร' })
  timeSlot!: string;

  // isActive = true แปลว่า caregiver ว่างรับงานในช่องนี้
  // optional + default true → ถ้า FE ไม่ส่งมาถือว่าเปิด (สะดวกตอน toggle ทั้งวัน)
  @Field({ defaultValue: true, description: 'Whether caregiver is available in this slot' })
  @IsOptional()
  @IsBoolean({ message: 'isActive ต้องเป็น true หรือ false' })
  isActive?: boolean;
}

/**
 * ServiceAreaInput — พื้นที่ให้บริการ (เก็บลงคอลัมน์บน caregivers โดยตรง)
 *
 * ทั้ง 2 field optional แยกกัน เผื่อ FE ส่งมาแค่จังหวัดก่อน แล้วค่อยเลือกเขตทีหลัง
 */
@InputType()
export class ServiceAreaInput {
  @Field({ nullable: true, description: 'Service area province (จังหวัด)' })
  @IsOptional()
  @IsString({ message: 'จังหวัดต้องเป็นข้อความ' })
  @MaxLength(100, { message: 'จังหวัดต้องไม่เกิน 100 ตัวอักษร' })
  province?: string;

  @Field({ nullable: true, description: 'Service area district (อำเภอ/เขต)' })
  @IsOptional()
  @IsString({ message: 'อำเภอ/เขตต้องเป็นข้อความ' })
  @MaxLength(100, { message: 'อำเภอ/เขตต้องไม่เกิน 100 ตัวอักษร' })
  district?: string;
}

/**
 * UpdateWorkConditionInput — payload ของ mutation `updateWorkCondition`
 *
 * ทุก section เป็น optional (partial update — ดู doc ด้านบนไฟล์)
 */
@InputType()
export class UpdateWorkConditionInput {
  @Field(() => [AvailabilitySlotInput], {
    nullable: true,
    description: 'Weekly availability grid. Send [] to clear all slots; omit to keep unchanged.',
  })
  @IsOptional()
  @IsArray({ message: 'availability ต้องเป็น array' })
  // ValidateNested + Type → สั่งให้ class-validator ตรวจ field ภายในแต่ละ slot ด้วย
  // (ต้องมี Type() ไม่งั้น nested object จะไม่ถูก transform เป็น class instance)
  @ValidateNested({ each: true })
  @Type(() => AvailabilitySlotInput)
  availability?: AvailabilitySlotInput[];

  @Field(() => [String], {
    nullable: true,
    description: 'Accepted job types. Send [] to clear all; omit to keep unchanged.',
  })
  @IsOptional()
  @IsArray({ message: 'jobTypes ต้องเป็น array' })
  @IsString({ each: true, message: 'jobTypes แต่ละรายการต้องเป็นข้อความ' })
  jobTypes?: string[];

  @Field(() => ServiceAreaInput, {
    nullable: true,
    description: 'Service area (province + district). Omit to keep unchanged.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => ServiceAreaInput)
  serviceArea?: ServiceAreaInput;
}
