import { Field, Float, ID, Int, ObjectType } from '@nestjs/graphql';

/**
 * JobEvent — หลักฐาน 1 เหตุการณ์ (เช็คอิน หรือ เช็คเอาท์) ที่ส่งกลับให้ FE
 *
 * ฟิลด์ 3 ตัวท้าย (gpsAccuracyLow / jobCoordsMissing / withinWarnRadius) เป็น
 * "ค่าที่คำนวณตอนอ่าน" ไม่ได้เก็บในตาราง — ตั้งใจแบบนั้น
 * เพราะ threshold อยู่ใน ENV ถ้าเก็บ boolean ไว้ตอนเขียน วันที่ threshold เปลี่ยน
 * ข้อมูลเก่าจะโกหกทันที และ backend กับ verdict จะตอบไม่ตรงกันตลอดไป
 */
@ObjectType()
export class JobEvent {
  @Field(() => ID)
  id: string;

  @Field(() => ID)
  bookingId: string;

  @Field({ description: "'check_in' | 'check_out'" })
  eventType: string;

  @Field({
    description:
      "'caregiver' = ผู้ดูแลกดเอง | 'system' = ระบบปิดให้อัตโนมัติ (งานที่ระบบปิดให้ ไม่นับว่า valid)",
  })
  source: string;

  @Field(() => Float, {
    nullable: true,
    description: 'ละติจูดที่บันทึกไว้ (null = ไม่ได้ให้สิทธิ์ตำแหน่ง)',
  })
  lat?: number;

  @Field(() => Float, { nullable: true, description: 'ลองจิจูดที่บันทึกไว้' })
  lng?: number;

  @Field(() => Int, {
    nullable: true,
    description: 'ระยะจากจุดงาน (เมตร). null = คำนวณไม่ได้ — ไม่ได้แปลว่าทำผิด',
  })
  distanceM?: number;

  @Field(() => Int, {
    nullable: true,
    description: 'ความแม่นยำของตำแหน่ง (เมตร)',
  })
  accuracyM?: number;

  @Field({ description: 'เวลาที่เซิร์ฟเวอร์บันทึก — เวลาที่ถือเป็นทางการ' })
  serverTs: Date;

  @Field({
    nullable: true,
    description: 'เวลาที่เครื่อง client อ้าง — metadata เท่านั้น',
  })
  deviceTs?: Date;

  @Field({ nullable: true, description: 'บันทึกปิดงาน (ใช้ตอน check_out)' })
  note?: string;

  @Field({
    nullable: true,
    description: 'signed URL ของรูปหลักฐาน — หมดอายุใน 1 ชม.',
  })
  photoUrl?: string;

  // ─── ค่าที่คำนวณตอนอ่าน (ไม่มีในตาราง) ──────────────────────────────────

  @Field({
    description:
      'true = สัญญาณตำแหน่งไม่แม่นพอที่จะเชื่อ distanceM → ระบบจะไม่ติดธงใด ๆ เลย. FE เอาไปโชว์ชิป "สัญญาณอ่อน"',
  })
  gpsAccuracyLow: boolean;

  @Field({
    description:
      'true = booking ใบนี้ไม่มีพิกัดจุดงาน (booking เก่าทุกใบเป็นแบบนี้) → คำนวณระยะไม่ได้ และไม่ติดธง',
  })
  jobCoordsMissing: boolean;

  @Field({
    nullable: true,
    description:
      'true = อยู่ในรัศมีปกติ (≤ WARN_RADIUS_M). false = นอกรัศมีแนะนำ แต่ยังไม่ถึงขั้นติดธง. null = ตัดสินไม่ได้',
  })
  withinWarnRadius?: boolean;

  @Field(() => [String], {
    description:
      'ธงที่เหตุการณ์นี้ทำให้เกิดขึ้น (array ว่าง = ไม่มีปัญหา) เช่น out_of_radius / out_of_window / clock_anomaly',
  })
  reviewReasons: string[];

  @Field({
    description:
      'true = แถวนี้มีอยู่ก่อนแล้ว ระบบคืนของเดิมให้ ไม่ได้สร้างใหม่ (กดปุ่มซ้ำ) — FE ไม่ต้องขึ้น error',
  })
  alreadyCheckedIn: boolean;
}
