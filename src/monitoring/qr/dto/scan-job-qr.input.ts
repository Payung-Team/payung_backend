import { Field, Float, InputType, Int } from '@nestjs/graphql';
import {
  IsInt,
  IsISO8601,
  IsLatitude,
  IsLongitude,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * ScanJobQrInput — สิ่งที่ผู้ดูแลส่งมาตอนสแกน QR ของงาน (PYG-435)
 *
 * ★ สังเกตว่า "ไม่มี bookingId" โดยตั้งใจ
 *   ตัว token บอกเองว่าเป็นงานใบไหน ถ้ารับ bookingId มาด้วยจะเกิดคำถามทันทีว่า
 *   "ถ้าสองค่าไม่ตรงกันจะเชื่ออันไหน" ซึ่งเป็นช่องโหว่ที่ไม่จำเป็นต้องมีตั้งแต่แรก
 *
 * ★ และ "ไม่มี action" ด้วย — ผู้ดูแลไม่ได้เลือกว่าจะเช็คอินหรือเช็คเอาท์
 *   สถานะปัจจุบันของ QR เป็นตัวตัดสิน (หลักการของการ์ดแม่ PYG-433)
 *   ถ้าให้ client ส่ง action มาเอง = เปิดทางให้ยิง CHECK_OUT ตั้งแต่ยังไม่เริ่มงาน
 *
 * ฟิลด์ที่เหลือคือของที่ระบบเช็คอิน/เช็คเอาท์เดิม (PYG-352/358) ต้องใช้
 * เพราะการสแกน "คือ" การเช็คอิน/เช็คเอาท์ ไม่ใช่ขั้นตอนแยกที่ทำก่อนหน้า
 */
@InputType()
export class ScanJobQrInput {
  @Field({
    description:
      'ข้อความดิบที่อ่านได้จาก QR — ส่งมาตามที่อ่านได้เป๊ะ ๆ ห้ามตัด/เติม/แปลงตัวพิมพ์',
  })
  @IsString()
  @IsNotEmpty()
  // ★ MaxLength กันคนยิงสตริงยาวเป็นเมกะไบต์มาให้เซิร์ฟเวอร์คำนวณ hash เล่น
  //   token จริงยาว 43 ตัว เผื่อไว้ 512 ก็เกินพอสำหรับ QR รูปแบบใหม่ในอนาคต
  @MaxLength(512)
  token: string;

  // ─── ตำแหน่ง: optional ทั้งหมด ด้วยเหตุผลเดียวกับ CheckInInput ────────────
  //     ★ GPS ไม่เคยทำให้การสแกนล้มเหลว มันทำได้แค่ "ติดธง" เท่านั้น
  //       ผู้ดูแลที่ไม่ให้สิทธิ์ตำแหน่ง ต้องสแกนเริ่มงานได้ตามปกติ

  @Field(() => Float, {
    nullable: true,
    description: 'ละติจูดตอนสแกน (null ได้ ถ้าไม่ได้ให้สิทธิ์ตำแหน่ง)',
  })
  @IsOptional()
  @IsLatitude()
  lat?: number;

  @Field(() => Float, { nullable: true, description: 'ลองจิจูดตอนสแกน' })
  @IsOptional()
  @IsLongitude()
  lng?: number;

  @Field(() => Int, {
    nullable: true,
    description: 'position.coords.accuracy หน่วยเมตร — ยิ่งมากยิ่งมั่ว',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  accuracyM?: number;

  @Field({
    nullable: true,
    description:
      'เวลาที่เครื่อง client อ้าง (ISO 8601) — metadata เท่านั้น เวลาจริงใช้ของเซิร์ฟเวอร์เสมอ',
  })
  @IsOptional()
  @IsISO8601()
  deviceTs?: string;

  // ─── ใช้เฉพาะตอนที่การสแกนกลายเป็น "เช็คเอาท์" ───────────────────────────
  //     ส่งมาตอนเช็คอินก็ไม่พัง แค่ถูกมองข้ามไปเฉย ๆ
  //     (FE รู้ล่วงหน้าว่าจะได้ action ไหน จาก jobQr.nextAction หรือสถานะงาน)

  @Field({
    nullable: true,
    description:
      'บันทึกปิดงาน — ใช้เฉพาะเมื่อการสแกนนี้กลายเป็นเช็คเอาท์ ยาวไม่เกิน 500 ตัวอักษร',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  @Field({
    nullable: true,
    description:
      "รูปหลักฐาน 1 รูป — ใช้เฉพาะตอนเช็คเอาท์ ต้องเป็นไฟล์ใน bucket 'job-evidence' ใต้โฟลเดอร์ของงานใบนั้น",
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  photoUrl?: string;
}
