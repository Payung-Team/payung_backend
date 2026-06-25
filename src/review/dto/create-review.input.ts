import { Field, ID, InputType, Int } from '@nestjs/graphql';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * CreateReviewInput — ข้อมูลที่ patient ส่งมาตอนเขียนรีวิว
 *
 * class-validator decorators (เช่น @Min/@Max/@MaxLength) จะถูกตรวจอัตโนมัติ
 * โดย global ValidationPipe ใน main.ts ก่อนเข้าถึง resolver
 * ถ้าไม่ผ่าน → ตอบ 400 Bad Request พร้อมข้อความบอกว่า field ไหนผิด
 */
@InputType()
export class CreateReviewInput {
  @Field(() => ID, {
    description: 'booking ที่จะรีวิว — ต้องเป็นของ patient คนนี้ และสถานะ completed',
  })
  @IsString()
  bookingId: string;

  @Field(() => Int, { description: 'คะแนนดาว 1–5' })
  @IsInt()
  @Min(1) // กันคะแนน 0 หรือติดลบ
  @Max(5) // กันคะแนนเกิน 5
  rating: number;

  @Field({ nullable: true, description: 'ข้อความรีวิว (ไม่บังคับ) ยาวไม่เกิน 500 ตัวอักษร' })
  @IsOptional()
  @IsString()
  @MaxLength(500) // ตรวจความยาวก่อน strip HTML (หลัง strip ยิ่งสั้นลงเท่านั้น)
  comment?: string;

  @Field({
    nullable: true,
    defaultValue: false,
    description: 'true = ไม่เปิดเผยชื่อผู้รีวิวบนหน้าโปรไฟล์ caregiver',
  })
  @IsOptional()
  @IsBoolean()
  isAnonymous?: boolean;
}
