import { Field, ID, ObjectType } from '@nestjs/graphql';
import { JobEvent } from '../../entities/job-event.entity';
import { ScanAction, ScanResult } from './scan-result.enum';

/**
 * JobScanResult — ผลของการสแกน QR 1 ครั้ง (PYG-435)
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★★ ทำไม mutation นี้ "คืนผลลัพธ์" แทนที่จะ "throw error" ★★
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ที่อื่นในรีโปนี้เวลาอะไรผิดจะ throw NestJS exception กันหมด แต่ตรงนี้ไม่ทำแบบนั้น
 * ด้วยเหตุผล 3 ข้อ:
 *
 *   1. การสแกนไม่ผ่าน "ไม่ใช่ความผิดปกติของระบบ" แต่เป็นผลลัพธ์ปกติของเครื่องสแกน
 *      คนจ่อกล้องผิดใบ / มาถึงเร็วไป / QR เก่าค้างอยู่ในมือ — เกิดทุกวัน
 *      สิ่งเหล่านี้ไม่ควรไปโผล่ในกราฟ error rate ปนกับดีบีล่ม
 *
 *   2. AC ของการ์ดบังคับว่า "เขียน JobScanEvent ทุกครั้ง (สำเร็จ+ล้มเหลว)"
 *      ถ้าใช้วิธี throw กระจายอยู่ 11 จุด วันหนึ่งจะมีสักจุดที่ลืมเขียน log
 *      พอบังคับให้ทุกทางออกต้องคืน object ก้อนนี้ การ log จะอยู่ที่ทางออกเดียว
 *
 *   3. FE (PYG-438) ต้องแยกหน้าจอตามสาเหตุ (ลองใหม่ / ติดต่อแอดมิน / กลับหน้างาน)
 *      อ่านจากฟิลด์ enum ง่ายและแม่นกว่าไปแกะ message ในก้อน error ของ GraphQL
 *
 * ⚠ ข้อยกเว้น: "ไม่ได้ล็อกอิน" กับ "role ไม่ใช่ผู้ดูแล" ยัง throw เหมือนเดิม
 *   สองอย่างนั้นถูกกันที่ชั้น guard ก่อนจะเข้ามาถึง service ด้วยซ้ำ
 * ══════════════════════════════════════════════════════════════════════════
 */
@ObjectType()
export class JobScanResult {
  @Field({
    description:
      'true = งานขยับจริง (เช็คอินหรือเช็คเอาท์สำเร็จ). false = ถูกปฏิเสธ ดูสาเหตุที่ result',
  })
  ok: boolean;

  @Field(() => ScanResult, {
    description: 'รหัสผลลัพธ์ — ใช้ค่านี้เลือกหน้าจอ ไม่ใช่ message',
  })
  result: ScanResult;

  @Field(() => ScanAction, {
    description:
      'สิ่งที่การสแกนครั้งนี้ทำ (หรือพยายามจะทำ) — ตัดสินจากสถานะของ QR ไม่ใช่จากตัว QR เอง',
  })
  action: ScanAction;

  @Field({
    description:
      'ข้อความภาษาไทยที่แสดงให้ผู้ดูแลอ่านได้ทันที (แสดงตรง ๆ ได้เลย ไม่ต้องแปลง)',
  })
  message: string;

  @Field(() => ID, {
    nullable: true,
    description:
      'งานที่ QR ใบนี้ผูกอยู่ — null เมื่อหา QR ไม่เจอ (ยังไม่รู้ว่าเป็นงานใบไหน)',
  })
  bookingId?: string;

  @Field({
    nullable: true,
    description:
      "สถานะของ QR 'หลัง' การสแกนครั้งนี้: 'PENDING' | 'CHECKED_IN' | 'CHECKED_OUT'. null เมื่อหา QR ไม่เจอ",
  })
  sessionStatus?: string;

  @Field({
    description:
      'เวลาที่เซิร์ฟเวอร์บันทึกการสแกนครั้งนี้ — เวลาที่ถือเป็นทางการ',
  })
  scannedAt: Date;

  @Field(() => JobEvent, {
    nullable: true,
    description:
      'หลักฐานการทำงานที่เพิ่งถูกบันทึก (มีเฉพาะตอน ok = true) — เอาไปโชว์ระยะทาง/ธงต่อได้เลย โดยไม่ต้องยิง proofOfWork ซ้ำ',
  })
  jobEvent?: JobEvent;
}
