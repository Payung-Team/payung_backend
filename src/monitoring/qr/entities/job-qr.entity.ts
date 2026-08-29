import { Field, ID, ObjectType } from '@nestjs/graphql';

/**
 * JobQr — ใบ QR ของงาน 1 ใบ ที่ส่งกลับให้ฝั่ง patient เอาไปวาดเป็นรูป QR (PYG-434)
 *
 * ★★ ก้อนข้อมูลนี้ "ลับ" ★★
 *    field `token` คือของจริงที่สแกนแล้วเช็คอิน/เช็คเอาท์ได้
 *    → resolver ปล่อยให้เฉพาะ patient เจ้าของ booking เท่านั้นที่เรียกได้
 *    → ห้าม log ค่านี้ ห้ามใส่ใน error message ห้ามส่งไปฝั่ง caregiver
 *
 * ⚠ ฝั่ง FE (PYG-437): เอา `token` ไปวาด QR ตรง ๆ ไม่ต้องเติม prefix หรือ URL ใด ๆ
 *   เพราะ PYG-435 (scanJobQr) จะ hash ค่าที่สแกนมา "ทั้งสตริง" แล้วเทียบกับดีบี
 *   ถ้าเติมอะไรเข้าไปแม้แต่ตัวเดียว hash จะไม่ตรงและสแกนไม่ผ่านทุกครั้ง
 */
@ObjectType()
export class JobQr {
  @Field(() => ID, { description: 'booking ที่ QR ใบนี้ผูกอยู่' })
  bookingId: string;

  @Field({
    description:
      '★ ข้อความลับที่เอาไปวาดเป็น QR — วาดตรง ๆ ทั้งสตริง ห้ามเติม prefix/URL. เฉพาะ patient เจ้าของงานเท่านั้นที่ขอค่านี้ได้',
  })
  token: string;

  @Field({
    description:
      "'PENDING' = ยังไม่เช็คอิน | 'CHECKED_IN' = กำลังทำงาน | 'CHECKED_OUT' = ปิดงานแล้ว",
  })
  status: string;

  @Field({
    description: 'สแกนได้ตั้งแต่เมื่อไหร่ (ก่อนเวลานัดได้ตามค่า config)',
  })
  validFrom: Date;

  @Field({
    description: 'สแกนได้ถึงเมื่อไหร่ (เลยเวลาเลิกงานได้ตามค่า config)',
  })
  validUntil: Date;

  // ─── ค่าที่คำนวณตอนอ่าน (ไม่มีในตาราง) ──────────────────────────────────
  // เหตุผลเดียวกับ JobEvent: ค่าพวกนี้ขึ้นกับ "เวลาปัจจุบัน" ซึ่งเปลี่ยนทุกวินาที
  // เก็บลงดีบีเมื่อไหร่ก็โกหกทันทีที่วินาทีถัดไปมาถึง

  @Field({
    description:
      'true = ตอนนี้สแกนได้จริง (อยู่ในช่วงเวลา + ยังไม่ปิดงาน). FE เอาไปตัดสินว่าจะโชว์ QR หรือโชว์ข้อความ "ยังไม่ถึงเวลา / หมดเวลาแล้ว"',
  })
  isActive: boolean;

  @Field({
    nullable: true,
    description:
      "สแกนครั้งต่อไปจะเป็น action อะไร: 'CHECK_IN' | 'CHECK_OUT' | null (ปิดงานแล้ว ไม่เหลือ action). FE เอาไปเขียนหัวข้อบนหน้าจอ",
  })
  nextAction?: string;
}
