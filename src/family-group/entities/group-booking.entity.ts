import { Field, Float, ID, ObjectType } from '@nestjs/graphql';
import { CaregiverBriefDto } from '../../booking/dto/booking-summary.types';

/**
 * PYG-385 — หนึ่งรายการในฟีด "นัดหมายของสมาชิก" ของกลุ่มครอบครัว
 *
 * เป็นการจองแทน (booking ที่มี family_group_id) ที่ทุกสมาชิกในกลุ่มเห็นร่วมกัน
 * ต่างจาก BookingSummary ตรงที่โชว์ "ใครเป็นคนจอง" (bookedByName/bookedByMe) เพราะฟีดของ
 * กลุ่มต้องแยกออกว่าใบไหนใครจอง — ไม่ใช่มุมมองของเจ้าของ booking คนเดียว
 */
@ObjectType()
export class GroupBookingSummary {
  @Field(() => ID) id: string;
  @Field({ description: 'วันที่ให้บริการ ISO "2026-09-15"' }) bookingDate: string;
  @Field({ nullable: true, description: 'เวลาเริ่ม "09:00"' }) startTime?: string;
  @Field() status: string;
  @Field() serviceType: string;
  @Field(() => Float, { nullable: true }) durationHours?: number;
  @Field({ nullable: true, description: 'ชื่อผู้รับบริการที่ถูกจองให้' })
  careRecipientName?: string;
  @Field(() => CaregiverBriefDto, { nullable: true }) caregiver?: CaregiverBriefDto;
  @Field({ nullable: true, description: 'ชื่อสมาชิกที่กดจอง' }) bookedByName?: string;
  @Field({ nullable: true, description: 'userId ของสมาชิกที่กดจอง — FE ใช้กรอง "การจองของสมาชิกคนนี้"' })
  bookedByUserId?: string;
  @Field({ description: 'true = ผู้เรียกเป็นคนจองเอง — FE ใช้ไฮไลต์ "คุณ"' })
  bookedByMe: boolean;

  // ── การ์ดนัดหมายในดีไซน์กลุ่ม (ราคา/สถานที่/รูปแบบ/สถานะเงิน/เช็คอิน) ──
  @Field(() => Float, { nullable: true, description: 'ราคาประเมิน (บาท)' })
  estimatedCost?: number;
  @Field(() => [String], { description: 'รูปแบบบริการ เช่น at_home / accompany_outside' })
  serviceLocations: string[];
  @Field({ nullable: true, description: 'ที่อยู่จุดให้บริการ' }) locationAddress?: string;
  @Field({ nullable: true, description: "สถานะการชำระเงิน เช่น 'held' = พักเงินไว้ (escrow)" })
  paymentStatus?: string;
  @Field({ nullable: true, description: 'เวลาเช็คอินจริง "09:04" (เขต Asia/Bangkok) ถ้ามี' })
  checkInTime?: string;
}
