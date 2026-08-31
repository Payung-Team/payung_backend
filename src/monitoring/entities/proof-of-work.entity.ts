import { Field, Int, ObjectType } from '@nestjs/graphql';
import { JobEvent } from './job-event.entity';

/**
 * ProofOfWorkSummary — "แหล่งความจริงเดียว" ที่ Epic 2 อ่านก่อนจะขยับเงิน (PYG-358)
 *
 * ★ ถ้า verdict ในนี้คำนวณผิด เงินจะไหลผิดทั้งระบบ
 *   นี่คือเหตุผลที่การ์ดบอกว่าไฟล์นี้กับการ์ด capture-gate ต้องรีวิวละเอียดที่สุด
 *
 * ข้อควรระวังเวลาอ่าน type นี้:
 *   - distanceInM / distanceOutM เป็น "ตัวเลขดิบ" ไม่ใช่ boolean
 *     ฝั่ง UI จะเอาไปเทียบ threshold เองเพื่อโชว์ป้าย
 *   - durationOk มีไว้ "โชว์" อย่างเดียว ห้ามเอาไปตัดสิน
 *     สิ่งที่ตัดสินจริงคือธง 'short_duration' ที่อยู่ใน reviewReasons แล้ว
 */
@ObjectType()
export class ProofOfWorkSummary {
  @Field(() => JobEvent, {
    nullable: true,
    description: 'แถวเช็คอิน (null = ยังไม่เช็คอิน)',
  })
  checkIn?: JobEvent;

  @Field(() => JobEvent, {
    nullable: true,
    description: 'แถวเช็คเอาท์ (null = ยังไม่ปิดงาน)',
  })
  checkOut?: JobEvent;

  @Field(() => Int, {
    nullable: true,
    description:
      'เวลาทำงานจริง (นาที) คำนวณจาก server_ts ทั้งสองฝั่ง. null เมื่อยังไม่ปิดงาน หรือเมื่อระบบปิดให้เอง',
  })
  actualMinutes?: number;

  @Field(() => Int, {
    description: 'เวลาที่จองไว้ (นาที) = duration_hours × 60',
  })
  bookedMinutes: number;

  @Field(() => Int, {
    nullable: true,
    description: 'ระยะห่างตอนเช็คอิน (เมตร) — ค่าดิบ',
  })
  distanceInM?: number;

  @Field(() => Int, {
    nullable: true,
    description: 'ระยะห่างตอนเช็คเอาท์ (เมตร) — ค่าดิบ',
  })
  distanceOutM?: number;

  @Field({
    description:
      '★ สำหรับ "แสดงผล" เท่านั้น ห้ามใช้ตัดสิน — ตัวตัดสินจริงคือธง short_duration ใน reviewReasons',
  })
  durationOk: boolean;

  @Field({
    description:
      'true = ไม่มีการเช็คเอาท์จากผู้ดูแล (ระบบปิดให้เอง หรือยังไม่ปิด)',
  })
  noCheckout: boolean;

  @Field({
    description:
      'true = booking ใบนี้ไม่มีพิกัดจุดงาน — เป็นช่องว่างของข้อมูลเรา ไม่ใช่ความผิดผู้ดูแล',
  })
  jobCoordsMissing: boolean;

  @Field(() => [String], {
    description: '★ ตัวตัดสินจริง — ธงทั้งหมดที่สะสมจากทั้งเช็คอินและเช็คเอาท์',
  })
  reviewReasons: string[];

  @Field({ description: 'true = มีข้อพิพาทค้างอยู่ (dispute_status != none)' })
  disputed: boolean;

  @Field({ description: "'valid' | 'needs_review' | 'incomplete'" })
  verdict: string;
}
