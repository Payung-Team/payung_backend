import { Field, Float, ID, InputType, Int } from '@nestjs/graphql';
import {
  IsInt,
  IsISO8601,
  IsLatitude,
  IsLongitude,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

/**
 * CheckInInput — ข้อมูลที่ผู้ดูแลส่งมาตอนกดปุ่ม "เช็คอินเริ่มงาน"
 *
 * ⚠ สังเกตว่า lat / lng / accuracyM / deviceTs เป็น optional ทั้งหมด
 *   ไม่ใช่ความหละหลวม แต่เป็นข้อกำหนดของดีไซน์:
 *   หน้าเช็คอินมีปุ่ม "ไม่อนุญาตตำแหน่ง — เช็คอินโดยไม่มีพิกัด" อยู่จริง
 *   และใต้ปุ่มเช็คอินเขียนว่า "ปุ่มเช็คอินกดได้เสมอ ไม่ว่าสัญญาณตำแหน่งจะเป็นอย่างไร"
 *   → ถ้าบังคับ lat/lng ที่ชั้นนี้ ปุ่มนั้นจะพังทันที
 */
@InputType()
export class CheckInInput {
  @Field(() => ID, {
    description: 'booking ที่จะเช็คอิน — ต้องเป็นงานของผู้ดูแลคนนี้',
  })
  @IsString()
  bookingId: string;

  @Field(() => Float, {
    nullable: true,
    description:
      'ละติจูดจาก browser (null ได้ ถ้าผู้ใช้ไม่อนุญาตสิทธิ์ตำแหน่ง)',
  })
  @IsOptional()
  @IsLatitude() // กันค่าเพี้ยนนอกช่วง -90..90
  lat?: number;

  @Field(() => Float, {
    nullable: true,
    description:
      'ลองจิจูดจาก browser (null ได้ ถ้าผู้ใช้ไม่อนุญาตสิทธิ์ตำแหน่ง)',
  })
  @IsOptional()
  @IsLongitude() // กันค่าเพี้ยนนอกช่วง -180..180
  lng?: number;

  @Field(() => Int, {
    nullable: true,
    description:
      'position.coords.accuracy หน่วยเมตร — ยิ่งมากยิ่งมั่ว. เกิน GPS_ACCURACY_TRUST_M แล้วระบบจะไม่ติดธงใด ๆ',
  })
  @IsOptional()
  @IsInt()
  @Min(0) // ความแม่นยำติดลบไม่มีอยู่จริง
  accuracyM?: number;

  @Field({
    nullable: true,
    description:
      'เวลาที่เครื่อง client อ้าง (ISO 8601) — เก็บเป็น metadata เท่านั้น เวลาจริงใช้ของเซิร์ฟเวอร์เสมอ',
  })
  @IsOptional()
  @IsISO8601()
  deviceTs?: string;
}
