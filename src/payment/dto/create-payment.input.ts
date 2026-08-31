/**
 * CreatePaymentInput (PYG-278) — รองรับทั้ง credit card (PYG-281) และ PromptPay
 *
 * paymentMethod:
 *  - 'credit_card' (default) → ต้องส่ง omiseToken (tokn_...) ที่ FE สร้างจาก Omise.js
 *  - 'promptpay'             → ไม่ต้องส่ง token; BE สร้าง PromptPay charge แล้วคืน qrCodeUrl
 *
 * ทำไม omiseToken ใช้ @ValidateIf?
 * - ต้องบังคับ "ใส่" เฉพาะ credit_card; PromptPay ส่งมาเกินจะให้ผ่าน (ignore) ก็ได้
 * - @ValidateIf((o) => o.paymentMethod === 'credit_card') → กฎ IsString/IsNotEmpty ทำงาน
 *   เฉพาะตอน paymentMethod='credit_card' เท่านั้น
 *
 * Co-authored hint:
 *  paymentMethod field ตรงกับสิ่งที่ Siwali commit ไว้ใน fix/payment&booking (59f8f17)
 *  — เพิ่ม @ValidateIf + omiseToken nullable + IsUUID/ID ให้ครบตามดีไซน์ของ Tina (a00f836)
 */
import { Field, ID, InputType } from '@nestjs/graphql';
import {
  IsIn,
  IsNotEmpty,
  IsString,
  IsUUID,
  ValidateIf,
} from 'class-validator';

@InputType()
export class CreatePaymentInput {
  @Field(() => ID, { description: 'UUID ของ booking ที่ต้องการชำระเงิน (ต้องมีสถานะ accepted)' })
  @IsUUID('4')
  bookingId: string;
  @Field({ defaultValue: 'credit_card', description: 'วิธีการชำระเงิน: credit_card | promptpay' })
  @IsIn(['credit_card', 'promptpay'])
  paymentMethod: string = 'credit_card';

  @Field({
    nullable: true,
    description: 'Omise card token (tokn_...) — จำเป็นสำหรับ credit_card เท่านั้น',
  })
  @ValidateIf((o: CreatePaymentInput) => o.paymentMethod === 'credit_card')
  @IsString()
  @IsNotEmpty()
  omiseToken?: string;
}
