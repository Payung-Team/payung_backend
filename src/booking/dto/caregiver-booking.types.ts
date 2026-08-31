import { Field, Float, ID, ObjectType } from '@nestjs/graphql';
// ใช้ BookingPagination ซ้ำจากฝั่ง patient (รูปทรง pagination เหมือนกัน ไม่ต้องสร้างใหม่)
import { BookingPagination } from './booking-summary.types';

/**
 * PatientBriefDto — ข้อมูล "ผู้ป่วย/ลูกค้า" แบบย่อ ที่ caregiver เห็นบนการ์ดงาน
 *
 * หมายเหตุ: ฝั่ง patient (BookingSummary) จะเห็นข้อมูล "caregiver" แบบย่อ
 *           แต่ฝั่ง caregiver (ไฟล์นี้) ต้องเห็นข้อมูล "patient" แทน
 *           จึงต้องมี DTO แยกกัน — ใช้ตัวเดิมไม่ได้เพราะมุมมองตรงข้ามกัน
 */
@ObjectType()
export class PatientBriefDto {
  @Field(() => ID) id: string;
  @Field({ nullable: true }) displayName?: string; // users.display_name (ชื่อที่แสดงบนการ์ด)
  @Field({ nullable: true }) avatarUrl?: string; // users.avatar_url (รูปโปรไฟล์)
}

/**
 * CaregiverBookingSummary — สรุป booking 1 รายการ สำหรับ "มุมมองของ caregiver"
 *
 * ใช้กับทุก tab ในหน้า "งานของฉัน":
 * - งานที่ต้องดำเนินการ (คำขอใหม่ = pending, รอผู้ป่วยยืนยัน = accepted)
 * - งานในกำหนดเวลา (active jobs = confirmed + upcoming)
 * - ประวัติงาน (history = ทุกสถานะ)
 */
@ObjectType()
export class CaregiverBookingSummary {
  @Field(() => ID) id: string;

  // สถานะปัจจุบัน: pending | accepted | confirmed | rejected | completed
  // เก็บเป็น string เพื่อให้สอดคล้องกับ BookingSummary ฝั่ง patient (contract เดิม)
  @Field() status: string;

  @Field() serviceType: string; // ประเภทบริการ เช่น "ดูแลผู้สูงอายุที่บ้านผู้ป่วย"
  @Field(() => [String]) serviceLocations: string[]; // รูปแบบ/สถานที่ให้บริการ
  @Field(() => [String]) tasks: string[]; // รายการงานที่ต้องปฏิบัติ
  @Field() timeSlot: string; // ช่วงเวลา เช่น "morning"

  @Field() bookingDate: string; // วันที่นัด รูปแบบ YYYY-MM-DD (string เพื่อเลี่ยงปัญหา timezone)
  @Field() startTime: string; // เวลาเริ่ม รูปแบบ HH:mm
  @Field(() => Float) durationHours: number; // ระยะเวลา (ชั่วโมง)

  @Field(() => Float, { nullable: true }) estimatedCost?: number; // ราคาประมาณการ (฿)

  @Field({ nullable: true }) locationAddress?: string;

  // PYG-352: พิกัดจุดงาน — หน้าเช็คอินของผู้ดูแลใช้ปักหมุด "จุดงาน"
  // และวาดวงรัศมี 200 ม. / 500 ม. รอบหมุดนั้น (ดีไซน์วาดวงไว้ตั้งแต่ก่อนเช็คอิน)
  // null = ไม่มีพิกัด → ไม่คำนวณระยะ ไม่ติดธง ไม่ลงโทษผู้ดูแล
  @Field(() => Float, { nullable: true }) locationLat?: number;
  @Field(() => Float, { nullable: true }) locationLng?: number;

  @Field({ nullable: true }) notes?: string; // บันทึกเพิ่มเติมจากผู้ป่วย

  @Field(() => PatientBriefDto) patient: PatientBriefDto; // ผู้จอง (ลูกค้า)

  // ชื่อผู้รับการดูแล — ถ้า null แปลว่าจองให้ "ตัวเอง" (สำหรับตัวเอง)
  @Field({ nullable: true }) careRecipientName?: string;

  @Field({ nullable: true }) acceptedAt?: Date; // เวลาที่ caregiver กดรับงาน (ticket #2)
  @Field({ nullable: true }) confirmedAt?: Date; // เวลาที่ patient ยืนยัน
  @Field({ nullable: true }) rejectionReason?: string; // เหตุผลที่ปฏิเสธ (ถ้ามี)

  @Field() createdAt: Date; // เวลาที่ผู้ป่วยส่งคำขอ (ใช้คำนวณ "ได้รับเมื่อ X ที่แล้ว")
}

/**
 * CaregiverBookingListResponse — ผลลัพธ์แบบมี pagination
 * รูปทรงเดียวกับ BookingListResponse ฝั่ง patient แต่ data เป็น CaregiverBookingSummary
 */
@ObjectType()
export class CaregiverBookingListResponse {
  @Field(() => [CaregiverBookingSummary]) data: CaregiverBookingSummary[];
  @Field(() => BookingPagination) pagination: BookingPagination;
}

