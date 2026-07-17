import { Field, Float, ID, Int, ObjectType } from '@nestjs/graphql';
import { DisputeStatus } from '../entities/dispute-status.enum';
import { DisputeFiledBy } from '../entities/dispute-filed-by.enum';
import { DisputePartyBrief } from '../entities/dispute-booking.entity';

/**
 * DisputeSummary — 1 แถวใน admin dispute queue (PYG-316)
 *
 * ตรงกับ contract ของ ticket: dispute_summary { id, booking_id, filed_by, amount, status, filed_at, sla_due_at }
 * + party briefs (patient/caregiver) เพื่อให้ FE แสดงชื่อ "ผู้ยื่น" ในตารางได้
 *
 * หมายเหตุ: ในระบบนี้ dispute ผูกกับ booking แบบ 1:1 (เก็บบน bookings) → dispute id = booking id
 */
@ObjectType()
export class DisputeSummary {
  // dispute id — เท่ากับ booking id (dispute เก็บบน booking)
  @Field(() => ID) id: string;

  // booking id (ตรง ๆ ตาม contract — ค่าเดียวกับ id ในสถาปัตยกรรมปัจจุบัน)
  @Field(() => ID) bookingId: string;

  // ผู้ยื่น: customer | caregiver (null ได้เฉพาะ dispute เดิมที่ backfill ไม่ครบ)
  @Field(() => DisputeFiledBy, { nullable: true }) filedBy?: DisputeFiledBy;

  // จำนวนเงินที่พิพาท = ยอด payment ของ booking (null ถ้าไม่มี payment)
  @Field(() => Float, { nullable: true }) amount?: number;
  @Field({ nullable: true }) currency?: string;

  // สถานะ dispute: flagged | resolved (queue ไม่แสดง 'none')
  @Field(() => DisputeStatus) status: DisputeStatus;

  // เวลาที่ยื่น (set ตอน flag)
  @Field({ nullable: true }) filedAt?: Date;

  // กำหนดต้องตัดสิน = filedAt + DISPUTE_SLA_HOURS (คำนวณใน service, ไม่ได้เก็บใน DB)
  @Field({ nullable: true }) slaDueAt?: Date;

  // ข้อมูลคู่กรณีเพื่อให้ FE แสดงชื่อในตาราง (ผู้ยื่น = patient ในปัจจุบัน)
  @Field(() => DisputePartyBrief) patient: DisputePartyBrief;
  @Field(() => DisputePartyBrief, { nullable: true })
  caregiver?: DisputePartyBrief;
}

/**
 * DisputeSummaryConnection — ผลลัพธ์ paginated ของ adminDisputes queue (PYG-316)
 * รูปแบบ pagination เดียวกับ connection อื่นในโปรเจกต์ (nodes + meta)
 */
@ObjectType()
export class DisputeSummaryConnection {
  @Field(() => [DisputeSummary]) nodes: DisputeSummary[];
  @Field(() => Int) totalCount: number;
  @Field(() => Int) page: number;
  @Field(() => Int) limit: number;
  @Field() hasNextPage: boolean;
}
