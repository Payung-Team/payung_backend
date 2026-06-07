import { Field, ID, InputType } from '@nestjs/graphql';
import { IsNotEmpty, IsString, IsUUID, MaxLength } from 'class-validator';

/**
 * DeclineBookingInput — input สำหรับ mutation `declineBooking` (ticket #4)
 *
 * caregiver ปฏิเสธคำขอที่ยังเป็น pending → status เปลี่ยนเป็น rejected
 * ตาม design: ช่อง "เหตุผลการปฏิเสธ *" เป็น field บังคับ (required)
 *
 * เทียบ REST เดิม: PATCH /api/v1/bookings/:id/decline  body: { decline_reason }
 */
@InputType()
export class DeclineBookingInput {
  @Field(() => ID)
  @IsUUID()
  bookingId: string;

  // เหตุผลบังคับ: ห้ามว่าง และจำกัดความยาวกันสแปม
  @Field()
  @IsString()
  @IsNotEmpty({ message: 'decline reason is required' })
  @MaxLength(500)
  reason: string;
}
