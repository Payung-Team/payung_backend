import { Field, Float, ID, InputType, Int } from '@nestjs/graphql';
import {
  IsInt,
  IsISO8601,
  IsLatitude,
  IsLongitude,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * CheckOutInput — ข้อมูลที่ผู้ดูแลส่งมาตอนกด "ยืนยันจบงาน" (PYG-358)
 *
 * ★ การเช็คเอาท์ = การปิดงาน (ทีมตัดสินใจ 2026-07-27)
 *   ผู้รับบริการไม่ต้องกดยืนยันอะไรอีกแล้ว งานจบตรงนี้เลย
 *
 * lat/lng ยัง optional เหมือนตอนเช็คอิน ด้วยเหตุผลเดียวกัน:
 * ผู้ดูแลอาจไม่ได้ให้สิทธิ์ตำแหน่ง แต่ต้องปิดงานได้เสมอ
 */
@InputType()
export class CheckOutInput {
  @Field(() => ID, { description: 'booking ที่จะปิดงาน — ต้องเช็คอินไปแล้ว' })
  @IsString()
  bookingId: string;

  @Field(() => Float, {
    nullable: true,
    description: 'ละติจูดตอนปิดงาน (null ได้)',
  })
  @IsOptional()
  @IsLatitude()
  lat?: number;

  @Field(() => Float, {
    nullable: true,
    description: 'ลองจิจูดตอนปิดงาน (null ได้)',
  })
  @IsOptional()
  @IsLongitude()
  lng?: number;

  @Field(() => Int, {
    nullable: true,
    description:
      'position.coords.accuracy หน่วยเมตร — เกินค่าที่เชื่อได้ ระบบจะไม่ติดธงระยะทาง',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  accuracyM?: number;

  @Field({
    nullable: true,
    description:
      'เวลาที่เครื่อง client อ้าง — เก็บเป็น metadata เท่านั้น ห้ามใช้คำนวณระยะเวลาทำงาน',
  })
  @IsOptional()
  @IsISO8601()
  deviceTs?: string;

  @Field({
    nullable: true,
    description:
      'บันทึกปิดงาน (ไม่บังคับ) ยาวไม่เกิน 500 ตัวอักษร — ดีไซน์โชว์ตัวนับ 0/500',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  @Field({
    nullable: true,
    description:
      "รูปหลักฐาน 1 รูป (ไม่บังคับ) — ต้องเป็นไฟล์ใน bucket 'job-evidence' ใต้โฟลเดอร์ของ booking นี้เท่านั้น URL จากที่อื่นจะถูกปฏิเสธ",
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  photoUrl?: string;
}
