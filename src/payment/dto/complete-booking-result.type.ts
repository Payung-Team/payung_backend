import { ObjectType, Field, ID, Float } from '@nestjs/graphql';
import { PaymentStatus as PaymentStatusEnum } from '../entities/payment-status.enum';

/**
 * CompleteBookingResult — ผลลัพธ์ของ mutation `completeBooking` (PYG-281)
 *
 * mutation นี้ทำ 2 อย่างพร้อมกัน (จบงาน + ตัดเงินจริง) จึงคืนผลรวมทั้งสองฝั่ง
 * เพื่อให้ frontend อัปเดต UI ได้ครบในครั้งเดียว:
 * - ฝั่ง booking: bookingId, status (= 'completed'), completedAt
 * - ฝั่ง payment: paymentStatus (= captured), amount, omiseChargeId
 */
@ObjectType()
export class CompleteBookingResult {
  /** id ของ booking ที่เพิ่งจบงาน */
  @Field(() => ID)
  bookingId: string;

  /** สถานะ booking หลังทำรายการ — คาดหวัง 'completed' */
  @Field()
  status: string;

  /** สถานะ payment หลัง capture — คาดหวัง captured */
  @Field(() => PaymentStatusEnum)
  paymentStatus: PaymentStatusEnum;

  /** จำนวนเงินที่ตัดจริง (สกุล THB) */
  @Field(() => Float)
  amount: number;

  /** charge id ของ Omise ที่ถูก capture */
  @Field({ nullable: true })
  omiseChargeId?: string;

  /** เวลาที่งานเสร็จสมบูรณ์ (booking.completed_at) */
  @Field()
  completedAt: Date;
}
