import { Field, ID, InputType } from '@nestjs/graphql';
import { IsNotEmpty, IsString, IsUUID, MaxLength } from 'class-validator';

/**
 * CancelAcceptanceInput — input สำหรับ mutation `cancelAcceptance` (undoc #10)
 *
 * กรณี: caregiver กดรับงานไปแล้ว (status=accepted, รอ patient ยืนยัน)
 *       แต่เปลี่ยนใจขอยกเลิกการรับงานก่อนที่ patient จะยืนยัน
 *       → status เปลี่ยนจาก accepted กลับไปเป็น rejected (พร้อมเหตุผลบังคับ)
 *
 * design ระบุลิงก์ "Cancel Acceptance" + modal ยืนยัน + ต้องระบุเหตุผล
 * เทียบ REST เดิม: PATCH /api/v1/bookings/:id/cancel-acceptance
 */
@InputType()
export class CancelAcceptanceInput {
  @Field(() => ID)
  @IsUUID()
  bookingId: string;

  @Field()
  @IsString()
  @IsNotEmpty({ message: 'cancellation reason is required' })
  @MaxLength(500)
  reason: string;
}
